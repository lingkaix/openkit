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
} from '@openkit/app-api-schemas';
import Database from 'better-sqlite3';
import type { Actor } from './auth/identity.js';
import {
  DeploymentAdminRequiredError,
  requireCurrentDeploymentAdmin,
} from './auth/operation-authorizer.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import { type FamilyImplementations, publicOperationActor } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { readRuntimeCleanupView } from './runtime/administrator-cleanup-view.js';
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
            if (!registry || !['active', 'deleting', 'deleted'].includes(registry.status)) {
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
            1 -
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
        sources: [deletion, ...runtime.sources],
        incomplete: deletion.incomplete || runtime.incomplete,
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

/** Keeps authority loss distinct from safe source-specific uncertainty. */
function requireAdministrator(coreDb: CoreDb, actor: Actor): void {
  try {
    requireCurrentDeploymentAdmin(coreDb, actor);
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
