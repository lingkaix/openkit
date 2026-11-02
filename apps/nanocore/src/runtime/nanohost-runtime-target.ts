import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import type { ControlRuntimeTargetInput } from '../storage/runtime-target-codecs.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import type * as records from './nanohost-runtime-target-records.js';

export {
  type AllocateNanoHostRuntimeTargetConnectionGenerationInput,
  getNanoHostRuntimeTarget,
  NanoHostCleanupFencePendingError,
  type NanoHostRuntimeTargetRecord,
  type NanoHostRuntimeTargetStatusObservation,
  type RecordNanoHostRuntimeTargetConnectionCloseInput,
  readConfiguredNanoHostRuntimeTargetStatus,
  requireNanoHostPhysicalEpoch,
  requireStoredNanoHostPhysicalEpoch,
  type UpsertNanoHostRuntimeTargetInput,
} from './nanohost-runtime-target-records.js';

/** Captures exact coordinates before posting to the existing physical Core owner. */
async function publishRuntimeTarget(db: CoreDb, input: ControlRuntimeTargetInput) {
  const snapshot = structuredClone(input);
  const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
  const database = `core:${scope.path}`;
  const client = getControlStoreWorkerClient();
  return client.runOperation(async () => {
    await client.open({
      database,
      path: scope.path,
      dataRoot: db.dataRoot,
      create: false,
      initialize: 'core',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    return client.runtimeTarget(database, snapshot);
  });
}

/** Allocates durable high-water before publishing physical connection authority. */
export async function allocateNanoHostRuntimeTargetConnectionGeneration(
  db: CoreDb,
  input: Parameters<typeof records.allocateNanoHostRuntimeTargetConnectionGeneration>[1]
) {
  return (await publishRuntimeTarget(db, {
    kind: 'allocate',
    targetId: input.targetId,
    identityId: input.identityId,
    deploymentId: input.deploymentId,
    observedAt: input.observedAt,
  }))!;
}

/** Commits the original exact readiness tuple before local readiness is published. */
export async function upsertNanoHostRuntimeTarget(
  db: CoreDb,
  input: Parameters<typeof records.upsertNanoHostRuntimeTarget>[1]
) {
  return (await publishRuntimeTarget(db, {
    kind: 'ready',
    targetId: input.targetId,
    identityId: input.identityId,
    deploymentId: input.deploymentId,
    observedAt: input.observedAt,
    connectionGeneration: input.connectionGeneration,
    predecessorFenced: input.predecessorFenced,
    ready: input.ready,
    freshEmpty: input.freshEmpty,
    physicalEpoch: input.physicalEpoch,
  }))!;
}

/** Persists the original monotone close only after Main has fenced process authority. */
export async function recordNanoHostRuntimeTargetConnectionClose(
  db: CoreDb,
  input: Parameters<typeof records.recordNanoHostRuntimeTargetConnectionClose>[1]
) {
  return (await publishRuntimeTarget(db, {
    kind: 'close',
    targetId: input.targetId,
    closedGeneration: input.closedGeneration,
    authoritativeGeneration: input.authoritativeGeneration,
    observedAt: input.observedAt,
  }))!;
}

/** Selects and fences the sole current target inside one native deciding section. */
export async function fenceNanoHostRuntimeTargetAfterRestart(db: CoreDb, observedAt: string) {
  return await publishRuntimeTarget(db, { kind: 'restart', observedAt });
}
