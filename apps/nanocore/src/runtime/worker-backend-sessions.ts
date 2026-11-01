import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import type { ControlBackendSessionInput } from '../storage/worker-backend-session-codecs.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import type * as records from './worker-backend-session-records.js';

export {
  getWorkerBackendSession,
  listWorkerBackendSessions,
  type MarkWorkerBackendSessionLaunchingInput,
  type MarkWorkerBackendWorkspaceHandoffCompleteInput,
  type RecordWorkerBackendSessionMaterializingInput,
  type TransitionWorkerBackendSessionStateInput,
  type WorkerBackendBuildLineage,
  type WorkerBackendLineage,
  type WorkerBackendReferenceLineage,
  type WorkerBackendSessionIdentity,
  type WorkerBackendSessionRecord,
  type WorkerBackendSessionState,
  workerBackendImageIdentity,
  workerBackendLineageFromRuntimeImage,
} from './worker-backend-session-records.js';

/** Captures immutable domain input, then posts to the existing Core physical owner. */
async function publishBackendSession(db: CoreDb, input: ControlBackendSessionInput) {
  const snapshot = structuredClone(input);
  const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
  const database = `core:${scope.path}`;
  const client = getControlStoreWorkerClient();
  await client.open({
    database,
    path: scope.path,
    dataRoot: db.dataRoot,
    create: false,
    initialize: 'core',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  return client.backendSession(database, snapshot);
}

/** Commits the original materializing tuple before acknowledging its dependent effect. */
export async function recordWorkerBackendSessionMaterializing(
  db: CoreDb,
  input: Parameters<typeof records.recordWorkerBackendSessionMaterializing>[1]
) {
  const { now, ...facts } = input;
  return publishBackendSession(db, {
    kind: 'materializing',
    ...facts,
    // Only the three retained binding coordinates cross this closed publication boundary.
    lineage: {
      workspaceId: facts.lineage.workspaceId,
      threadId: facts.lineage.threadId,
      turnId: facts.lineage.turnId,
    },
    ...(now ? { observedAt: now() } : {}),
  });
}

/** Commits the original transition tuple before acknowledging its dependent effect. */
export async function transitionWorkerBackendSessionState(
  db: CoreDb,
  input: Parameters<typeof records.transitionWorkerBackendSessionState>[1]
) {
  const { now, ...facts } = input;
  return publishBackendSession(db, {
    kind: 'transition',
    ...facts,
    ...(now ? { observedAt: now() } : {}),
  });
}

/** Commits the original launching tuple before acknowledging its dependent effect. */
export async function markWorkerBackendSessionLaunching(
  db: CoreDb,
  input: Parameters<typeof records.markWorkerBackendSessionLaunching>[1]
) {
  const { now, ...facts } = input;
  return publishBackendSession(db, {
    kind: 'launching',
    ...facts,
    ...(now ? { observedAt: now() } : {}),
  });
}

/** Commits the original handoff tuple before acknowledging its dependent effect. */
export async function markWorkerBackendWorkspaceHandoffComplete(
  db: CoreDb,
  input: Parameters<typeof records.markWorkerBackendWorkspaceHandoffComplete>[1]
) {
  const { now, ...facts } = input;
  return publishBackendSession(db, {
    kind: 'handoff',
    ...facts,
    ...(now ? { observedAt: now() } : {}),
  });
}

/** Commits the original retire-orphan tuple before acknowledging its dependent effect. */
export async function retireOrphanWorkerBackendSession(
  db: CoreDb,
  input: Parameters<typeof records.retireOrphanWorkerBackendSession>[1]
) {
  const { now, ...facts } = input;
  return publishBackendSession(db, {
    kind: 'retire-orphan',
    ...facts,
    ...(now ? { observedAt: now() } : {}),
  });
}
