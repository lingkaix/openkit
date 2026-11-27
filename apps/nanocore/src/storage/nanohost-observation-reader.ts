import type Database from 'better-sqlite3';
import type { StorageResult } from './storage-owner.js';

type NanoHostRead = <Value>(
  dataRoot: string,
  query: (sqlite: Database.Database) => Value
) => StorageResult<'nanohost', Value>;

let readCurrentOpening: NanoHostRead = () => ({
  state: 'unavailable',
  owner: 'nanohost',
  reason: 'missing',
});

/** Supplies the live opening lookup without making retained projections depend on the Worker client. */
export function bindNanoHostObservationReader(read: NanoHostRead): void {
  readCurrentOpening = read;
}

/** Resolves each read against the currently acknowledged opening for this Data Root. */
export function readNanoHostObservation<Value>(
  dataRoot: string,
  query: (sqlite: Database.Database) => Value
): StorageResult<'nanohost', Value> {
  return readCurrentOpening(dataRoot, (sqlite) =>
    sqlite.transaction(() => query(sqlite)).deferred()
  );
}
