import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  getNanoHostRuntimeTarget,
  requireStoredNanoHostPhysicalEpoch,
} from '../runtime/nanohost-runtime-target-records.js';
import {
  getWorkerBackendSession,
  getWorkerBackendSessionByPackage,
} from '../runtime/worker-backend-session-records.js';
import type { NanoHostCoreReads } from './control-kernel-port.js';
import type { StorageResult } from './storage-owner.js';

const bindingRef = z.string().min(1);
const pageLimit = z.number().int().min(1).max(128);
const resident = z.object({
  binding: bindingRef,
  origin: z.string().transform(requireStoredNanoHostPhysicalEpoch),
  target: z.string().min(1),
  drain: z.enum(['accepting', 'draining']),
  refusalDrained: z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1),
});

/** The owning admission rechecks the captured query-only opening for each read. */
export function createNanoHostCoreReads(owner: {
  read<Value>(query: (sqlite: Database.Database) => Value): StorageResult<'nanohost', Value>;
}): NanoHostCoreReads {
  return {
    readTarget: (targetId) =>
      owner.read((sqlite) => getNanoHostRuntimeTarget({ sqlite }, targetId)),
    readBackendSession: (key) =>
      owner.read((sqlite) =>
        'attemptId' in key
          ? getWorkerBackendSession({ sqlite }, key.attemptId)
          : getWorkerBackendSessionByPackage({ sqlite }, key.packageSnapshotId)
      ),
    readResident: (binding) =>
      owner.read((sqlite) => {
        const row = sqlite
          .prepare(
            `SELECT sandbox_binding_ref AS binding, origin_physical_epoch AS origin,
               runtime_target_id AS target, drain_state AS drain,
               lifecycle_state='open' AND health_state='ready' AND cleanup_state='clean'
               AND drain_state='draining' AND NOT EXISTS (
                 SELECT 1 FROM harness_instance_records h
                 WHERE h.sandbox_runtime_id=s.sandbox_runtime_id AND
                   (h.drain_state <> 'draining' OR h.lifecycle_state <> 'failed')
               ) AS refusalDrained
             FROM sandbox_runtime_records s WHERE sandbox_binding_ref = ?`
          )
          .get(bindingRef.parse(binding));
        return row === undefined ? null : resident.parse(row);
      }),
    listDrainingResidents: (after, limit) =>
      owner.read((sqlite) => {
        const size = pageLimit.parse(limit);
        const select =
          "SELECT sandbox_binding_ref FROM sandbox_runtime_records WHERE drain_state = 'draining'";
        const rows =
          after === null
            ? sqlite
                .prepare(`${select} ORDER BY sandbox_binding_ref LIMIT ?`)
                .pluck()
                .all(size + 1)
            : sqlite
                .prepare(
                  `${select} AND sandbox_binding_ref > ? ORDER BY sandbox_binding_ref LIMIT ?`
                )
                .pluck()
                .all(bindingRef.parse(after), size + 1);
        const bindings = rows.map((binding) => bindingRef.parse(binding));
        return {
          bindings: bindings.slice(0, size),
          next: bindings.length > size ? bindings[size - 1]! : null,
        };
      }),
  };
}
