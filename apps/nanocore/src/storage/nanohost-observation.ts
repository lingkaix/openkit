import type Database from 'better-sqlite3';
import { OperationError } from '../operation-error.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import type { CoreDb } from './db.js';
import {
  bindNanoHostObservationReader,
  readNanoHostObservation,
} from './nanohost-observation-reader.js';
import type { AdmittedNanoHostTransportStorage } from './nanohost-transport-owner.js';

bindNanoHostObservationReader((dataRoot, query) =>
  getControlStoreWorkerClient().readAdmittedNanoHost(dataRoot, query)
);

/** Keeps one snapshot on the acknowledged owner and stops at the existing storage hold. */
export function requireNanoHostObservation<Value>(
  coreDb: Pick<CoreDb, 'dataRoot'>,
  query: (sqlite: Database.Database) => Value,
  read?: AdmittedNanoHostTransportStorage['owner']['read']
): Value {
  const result = read
    ? read((sqlite) => sqlite.transaction(() => query(sqlite)).deferred())
    : readNanoHostObservation(coreDb.dataRoot, query);
  if (result.state !== 'ready')
    throw new OperationError(
      'operation_storage_unavailable',
      'NanoHost runtime storage is unavailable.',
      503
    );
  return result.value;
}
