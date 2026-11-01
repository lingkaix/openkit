import { NativeEnvironmentRecordSchema } from '@openkit/worker-protocol';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import type { ControlWorkerImageInput } from '../storage/worker-image-codecs.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import {
  type WorkerImageSettlement,
  type WorkerImageSettlementIdentity,
  WorkerImageSettlementIdentitySchema,
  WorkerImageSettlementSchema,
} from './worker-image-settlements-records.js';

export {
  readAdmittedWorkerImageEnvironment,
  readWorkerImageSettlement,
  type WorkerImageSettlement,
  WorkerImageSettlementConflict,
  WorkerImageSettlementDeferred,
  type WorkerImageSettlementIdentity,
  WorkerImageSettlementIdentitySchema,
  WorkerImageSettlementSchema,
} from './worker-image-settlements-records.js';

/** Retains the exact existing producer until the physical owner returns its covering FULL acknowledgement. */
async function publishWorkerImage(db: CoreDb, input: ControlWorkerImageInput): Promise<void> {
  const snapshot = structuredClone(input);
  const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
  const database = `core:${scope.path}`;
  const client = getControlStoreWorkerClient();
  await client.runOperation(async () => {
    await client.open({
      database,
      path: scope.path,
      dataRoot: db.dataRoot,
      create: false,
      initialize: 'core',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    await client.workerImage(database, snapshot);
  });
}

/** Commits the immutable image receipt and its original journal tuple atomically, never a remote retry. */
export async function writeWorkerImageSettlement(
  db: CoreDb,
  input: WorkerImageSettlement
): Promise<void> {
  await publishWorkerImage(db, {
    kind: 'settlement',
    value: WorkerImageSettlementSchema.parse(input),
  });
}

/** Admits confirmed defaults in the original separate stage before package resolution. */
export async function admitWorkerImageEnvironment(
  db: CoreDb,
  candidate: WorkerImageSettlementIdentity,
  input: unknown
): Promise<void> {
  await publishWorkerImage(db, {
    kind: 'environment',
    candidate: WorkerImageSettlementIdentitySchema.parse(candidate),
    environment: NativeEnvironmentRecordSchema.parse(input),
  });
}
