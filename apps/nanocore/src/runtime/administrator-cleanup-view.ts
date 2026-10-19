import { Buffer } from 'node:buffer';
import {
  ADMINISTRATOR_CLEANUP_MAX_BYTES,
  ADMINISTRATOR_CLEANUP_MAX_ENTRIES,
  ADMINISTRATOR_CLEANUP_SOURCE_OWNERS,
  AdministratorCleanupItemSchema,
  type AdministratorCleanupReadResponse,
  type AdministratorCleanupRuntimeItem,
} from '@openkit/app-api-schemas';
import type { Actor } from '../auth/identity.js';
import {
  DeploymentAdminRequiredError,
  requireCurrentDeploymentAdmin,
} from '../auth/operation-authorizer.js';
import { OperationError } from '../operation-error.js';
import type { CoreDb } from '../storage/db.js';
import {
  getNanoHostRuntimeTarget,
  requireNanoHostPhysicalEpoch,
  requireStoredNanoHostPhysicalEpoch,
} from './nanohost-runtime-target.js';

/** Runtime sources in the public contract's stable order; deletion belongs to P12. */
const runtimeSources = [
  'execution-attempt',
  'backend-session',
  'agent-session-binding',
  'sandbox-runtime',
  'worker-storage',
] as const;

/** The five existing Core record owners observed by this reader. */
type RuntimeSource = (typeof runtimeSources)[number];
/** Public item branches restricted to the runtime sources. */
export type RuntimeCleanupItem = AdministratorCleanupRuntimeItem;
/** Runtime source coverage derived from the shared public contract. */
type RuntimeSourceCoverage = Omit<AdministratorCleanupReadResponse['sources'][number], 'source'> & {
  source: RuntimeSource;
};
/** Runtime fragment; the public operation adds its deletion source and complete-response bound. */
export type RuntimeCleanupView = Omit<AdministratorCleanupReadResponse, 'items' | 'sources'> & {
  items: RuntimeCleanupItem[];
  sources: RuntimeSourceCoverage[];
};
/** Trusted invocation inputs, never caller-selected public options. */
export interface ReadRuntimeCleanupViewInput {
  /** Existing Core authority and source records. */
  readonly coreDb: CoreDb;
  /** Original authenticated actor, not an ActorRef or retained eligibility result. */
  readonly actor: Actor | undefined;
  /** Trusted observation time; no live Host inspection follows from it. */
  readonly now: Date;
  /** Aggregate runtime item ceiling, within the shared public maximum. */
  readonly maxEntries: number;
  /** Whole-fragment UTF-8 JSON ceiling, within the shared public maximum. */
  readonly maxBytes: number;
}

/** Only known state and opaque target columns enter the projection, never private payloads. */
const sourceSelects: Record<RuntimeSource, string> = {
  'execution-attempt': `SELECT attempt_id, workspace_id, thread_id, turn_id, agent_session_id,
    phase, disposition, updated_at FROM scheduler_execution_attempts ORDER BY attempt_id LIMIT ?`,
  'backend-session': `SELECT attempt_id, workspace_id, thread_id, turn_id, agent_session_id,
    state, workspace_handoff_state, physical_cleaned_at, updated_at, runtime_target_id,
    origin_physical_epoch, deployment_id
    FROM worker_backend_sessions ORDER BY attempt_id LIMIT ?`,
  'agent-session-binding': `SELECT agent_session_runtime_binding_id, agent_session_id,
    workspace_id, thread_id, lifecycle_state, cleanup_state, updated_at
    FROM agent_session_runtime_bindings ORDER BY agent_session_runtime_binding_id LIMIT ?`,
  'sandbox-runtime': `SELECT sandbox_runtime_id, runtime_target_id, lifecycle_state,
    health_state, drain_state, cleanup_state, updated_at, origin_physical_epoch
    FROM sandbox_runtime_records ORDER BY sandbox_runtime_id LIMIT ?`,
  'worker-storage': `SELECT storage_ref, workspace_id, runtime_target_id, state, revision,
    purged_at, updated_at,
    (current_agent_session_id IS NULL AND current_sandbox_binding_ref IS NULL
      AND current_thread_id IS NULL AND current_work_slot_ref IS NULL) AS unattached,
    EXISTS (SELECT 1 FROM worker_storage_contributors AS contributor
      WHERE contributor.storage_ref = worker_storage_bindings.storage_ref) AS has_contributors
    FROM worker_storage_bindings ORDER BY storage_ref LIMIT ?`,
};

/**
 * Reads bounded current cleanup observations without opening Workspaces or performing cleanup.
 *
 * @param input Current authority, trusted clock and admitted aggregate budgets.
 * @returns Five-source fragment with explicit unavailable or incomplete coverage.
 * @throws DeploymentAdminRequiredError when current administrator authority is absent.
 * @throws OperationError when authority storage or the Core snapshot is unavailable.
 * @throws RangeError when an internal budget cannot carry the required metadata or exceeds a cap.
 */
export function readRuntimeCleanupView(input: ReadRuntimeCleanupViewInput): RuntimeCleanupView {
  requireAdministrator(input);
  const observedAt = input.now.toISOString();
  requireBudgets(input);
  const result: RuntimeCleanupView = {
    observedAt,
    items: [],
    sources: runtimeSources.map((source) => ({
      source,
      availability: 'available',
      incomplete: false,
      reasons: [],
    })),
    incomplete: false,
  };
  // Stage at most one bounded prefix, reserving the complete five-source envelope. Unvisited
  // source facts are provisional until the loop observes them or records its stopping reason.
  // Coverage flags can grow; the final admission below tightens only the staged prefix.
  if (metadataBytes(result) > input.maxBytes) {
    throw new RangeError('The runtime cleanup byte budget cannot carry source coverage.');
  }

  let itemBytes = 0;
  let remainingWork = input.maxEntries + 1;
  let exhausted: 'count_limit' | 'byte_limit' | undefined;
  try {
    input.coreDb.sqlite.transaction(() => {
      for (const coverage of result.sources) {
        // A denied source must never become a successful partial disclosure, even after a limit.
        requireAdministrator(input);
        if (exhausted || result.items.length === input.maxEntries || remainingWork === 0) {
          coverage.availability = 'unavailable';
          coverage.incomplete = true;
          coverage.reasons = [exhausted ?? 'count_limit', 'source_unavailable'];
          continue;
        }
        try {
          if (coverage.source !== 'sandbox-runtime') {
            // Establish the Workspace source-authority dependency without enumerating its ids.
            input.coreDb.sqlite.prepare('SELECT status FROM workspace_registry LIMIT 0').get();
          }
          const limit = Math.min(input.maxEntries - result.items.length + 1, remainingWork);
          const rows = input.coreDb.sqlite.prepare(sourceSelects[coverage.source]).iterate(limit);
          coverage.availability = 'available';
          coverage.incomplete = false;
          coverage.reasons = [];
          for (const row of rows) {
            remainingWork -= 1;
            if (result.items.length === input.maxEntries) {
              exhausted = 'count_limit';
              break;
            }
            const item = projectRecord(input.coreDb, coverage.source, row, observedAt);
            const addedBytes = jsonBytes(item) + (result.items.length > 0 ? 1 : 0);
            if (metadataBytes(result) + itemBytes + addedBytes > input.maxBytes) {
              exhausted = 'byte_limit';
              break;
            }
            result.items.push(item);
            itemBytes += addedBytes;
          }
          if (remainingWork === 0 && !exhausted) exhausted = 'count_limit';
          if (exhausted) {
            coverage.incomplete = true;
            coverage.reasons = [exhausted];
          }
        } catch {
          // Keep only observations already independently admitted. No identifier or raw error
          // from the unavailable record is returned, and other source owners remain readable.
          coverage.availability = 'unavailable';
          coverage.incomplete = true;
          coverage.reasons = ['source_unavailable'];
        }
        // Known failure or sentinel metadata cannot shrink in a later source. Stop row work
        // immediately when that observation exhausts the remaining encoded prefix budget.
        if (metadataBytes(result) + itemBytes > input.maxBytes) exhausted = 'byte_limit';
      }
    })();
  } catch (error) {
    if (error instanceof DeploymentAdminRequiredError || error instanceof OperationError)
      throw error;
    throw unavailable(error);
  }
  // Publication authority is current after the snapshot, rather than pinned by its earlier read.
  requireAdministrator(input);
  result.incomplete = result.sources.some((source) => source.incomplete);
  // Admission includes actual coverage metadata, not only item bytes. No new source reads or
  // retries occur while trimming at most maxEntries already validated observations.
  while (jsonBytes(result) > input.maxBytes && result.items.length > 0) {
    const omitted = result.items.pop()!;
    const coverage = result.sources.find((entry) => entry.source === omitted.source)!;
    coverage.incomplete = true;
    if (!coverage.reasons.includes('byte_limit')) coverage.reasons.push('byte_limit');
    result.incomplete = true;
  }
  if (jsonBytes(result) > input.maxBytes) {
    throw new RangeError('The runtime cleanup byte budget cannot carry source coverage.');
  }
  return result;
}

/** Checks the existing authority owner without converting a denial into source availability. */
function requireAdministrator(input: ReadRuntimeCleanupViewInput): void {
  try {
    requireCurrentDeploymentAdmin(input.coreDb, input.actor, input.now);
  } catch (error) {
    if (error instanceof DeploymentAdminRequiredError) throw error;
    throw unavailable(error);
  }
}

/** Keeps raw storage failures private while preserving the operation-level unavailable boundary. */
function unavailable(cause: unknown): OperationError {
  return new OperationError(
    'administrator_cleanup_unavailable',
    'Administrator cleanup authority storage is unavailable.',
    503,
    { cause }
  );
}

/** Rejects internal admission mistakes instead of silently expanding the public work envelope. */
function requireBudgets(input: ReadRuntimeCleanupViewInput): void {
  if (
    !Number.isSafeInteger(input.maxEntries) ||
    input.maxEntries < 0 ||
    input.maxEntries > ADMINISTRATOR_CLEANUP_MAX_ENTRIES ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes <= 0 ||
    input.maxBytes > ADMINISTRATOR_CLEANUP_MAX_BYTES
  ) {
    throw new RangeError('Runtime cleanup budgets exceed their admitted bounds.');
  }
}

/** Measures the exact compact JSON encoding used by the shared response bound. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Reserves every known coverage fact before staging another item. */
function metadataBytes(result: RuntimeCleanupView): number {
  return jsonBytes({
    ...result,
    items: [],
    incomplete: result.sources.some((source) => source.incomplete),
  });
}

/** Admits a fixed source target before the public schema selects its known fields. */
function projectRecord(
  coreDb: CoreDb,
  source: RuntimeSource,
  raw: unknown,
  observedAt: string
): RuntimeCleanupItem {
  const row = raw as Record<string, unknown>;
  if (source !== 'sandbox-runtime') {
    const workspace = coreDb.sqlite
      .prepare('SELECT status FROM workspace_registry WHERE workspace_id = ?')
      .get(row.workspace_id) as { status: unknown } | undefined;
    if (!workspace || !['active', 'deleting', 'deleted'].includes(String(workspace.status))) {
      throw new Error('Cleanup source scope is unavailable.');
    }
  }
  if (source === 'worker-storage' && row.has_contributors !== 0) {
    // Legacy private-volume metadata still depends on current contributor/Thread source access.
    // Core rows alone cannot establish that audience; this read never opens Workspace content.
    throw new Error('Cleanup source audience is unavailable.');
  }
  return projectKnownFields(coreDb, source, row, observedAt);
}

/** Unknown evidence reasons are shared contract values, not new cleanup states. */
type UnknownProofReason = Extract<RuntimeCleanupItem['evidence'], { kind: 'unknown' }>['reason'];
/** Private qualified Epoch observation; neither witnesses nor this comparison are public authority. */
interface EpochObservation {
  readonly relation: 'same' | 'different' | 'unknown';
  readonly reason: UnknownProofReason;
}

/**
 * Compares only current, owner-qualified stored Epoch witnesses. A disconnected target or a
 * different deployment cannot turn old source state into current cleanup proof.
 */
function observeEpoch(coreDb: CoreDb, row: Record<string, unknown>): EpochObservation {
  try {
    if (typeof row.runtime_target_id !== 'string' || typeof row.origin_physical_epoch !== 'string')
      return { relation: 'unknown', reason: 'missing' };
    requireStoredNanoHostPhysicalEpoch(row.origin_physical_epoch);
    const target = getNanoHostRuntimeTarget(coreDb, row.runtime_target_id);
    if (!target) return { relation: 'unknown', reason: 'missing' };
    if (row.deployment_id !== undefined && target.deploymentId !== row.deployment_id)
      return { relation: 'unknown', reason: 'contradictory' };
    if (!target.predecessorFenced || !target.ready || !target.freshEmpty || !target.physicalEpoch)
      return { relation: 'unknown', reason: 'stale' };
    requireNanoHostPhysicalEpoch(target.physicalEpoch);
    return {
      relation: target.physicalEpoch === row.origin_physical_epoch ? 'same' : 'different',
      reason: 'missing',
    };
  } catch {
    return { relation: 'unknown', reason: 'unavailable' };
  }
}

/** Selects only the shared closed branch's target, owner state and source-defined proof facts. */
function projectKnownFields(
  coreDb: CoreDb,
  source: RuntimeSource,
  row: Record<string, unknown>,
  observedAt: string
): RuntimeCleanupItem {
  const sourceOwner = ADMINISTRATOR_CLEANUP_SOURCE_OWNERS[source];
  let target: Record<string, unknown>;
  let state: Record<string, unknown>;
  let reason: UnknownProofReason = 'missing';
  let recordedAt: unknown;
  switch (source) {
    case 'execution-attempt':
      target = {
        kind: source,
        attemptId: row.attempt_id,
        workspaceId: row.workspace_id,
        threadId: row.thread_id,
        turnId: row.turn_id,
        agentSessionId: row.agent_session_id,
      };
      state = { phase: row.phase, disposition: row.disposition };
      if (row.disposition === 'unknown') reason = 'unavailable';
      break;
    case 'backend-session': {
      const epoch = observeEpoch(coreDb, row);
      target = {
        kind: source,
        attemptId: row.attempt_id,
        workspaceId: row.workspace_id,
        threadId: row.thread_id,
        turnId: row.turn_id,
        agentSessionId: row.agent_session_id,
      };
      state = {
        state: row.state,
        workspaceHandoffState: row.workspace_handoff_state,
        physicalCleanedAt: row.physical_cleaned_at,
        physicalEpochRelation: epoch.relation,
      };
      const cleaned = row.state === 'physical-cleaned' || row.state === 'cleaned';
      if (cleaned && typeof row.physical_cleaned_at === 'string') {
        // This immutable backend receipt remains a physical observation, not a product barrier.
        recordedAt = row.physical_cleaned_at;
      } else if (cleaned || row.physical_cleaned_at !== null) {
        reason = 'contradictory';
      } else if (epoch.relation === 'unknown') {
        reason = epoch.reason;
      } else if (epoch.relation === 'different') {
        reason = 'stale';
      }
      break;
    }
    case 'agent-session-binding':
      target = {
        kind: source,
        agentSessionRuntimeBindingId: row.agent_session_runtime_binding_id,
        agentSessionId: row.agent_session_id,
        workspaceId: row.workspace_id,
        threadId: row.thread_id,
      };
      state = { lifecycleState: row.lifecycle_state, cleanupState: row.cleanup_state };
      if (row.cleanup_state === 'unknown') reason = 'unavailable';
      // updated_at dates a row transition; it is not a separate session.close proof timestamp.
      break;
    case 'sandbox-runtime': {
      const epoch = observeEpoch(coreDb, row);
      target = {
        kind: source,
        sandboxRuntimeId: row.sandbox_runtime_id,
        runtimeTargetId: row.runtime_target_id,
      };
      state = {
        lifecycleState: row.lifecycle_state,
        healthState: row.health_state,
        drainState: row.drain_state,
        cleanupState: row.cleanup_state,
        physicalEpochRelation: epoch.relation,
      };
      if (epoch.relation === 'unknown') reason = epoch.reason;
      else if (epoch.relation === 'different') reason = 'stale';
      else if (row.cleanup_state === 'unknown') reason = 'unavailable';
      // A comparison labels stored lineage; it does not synthesize a Sandbox cleanup receipt.
      break;
    }
    case 'worker-storage':
      target = {
        kind: source,
        storageRef: row.storage_ref,
        workspaceId: row.workspace_id,
        runtimeTargetId: row.runtime_target_id,
      };
      state = { state: row.state, revision: row.revision, purgedAt: row.purged_at };
      if (row.state === 'purged' && typeof row.purged_at === 'string' && row.unattached === 1) {
        recordedAt = row.purged_at;
      } else if (row.state === 'purged' || row.purged_at !== null) {
        reason = 'contradictory';
      } else if (row.state === 'unknown') reason = 'unavailable';
      break;
  }
  return AdministratorCleanupItemSchema.parse({
    source,
    sourceOwner,
    target,
    state,
    sourceUpdatedAt: row.updated_at,
    observedAt,
    evidence:
      recordedAt === undefined
        ? { kind: 'unknown', reason }
        : { kind: 'recorded', recordedAt, reference: target },
    nextInspection: { kind: 'source-record', sourceOwner, target },
  }) as RuntimeCleanupItem;
}
