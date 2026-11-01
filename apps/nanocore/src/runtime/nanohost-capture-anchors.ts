import { readRetainedV1 } from '@openkit/protocol';
import type { CoreDb } from '../storage/db.js';
import { nanoHostSandboxIdFromBackendSessionId } from './nanohost-effect-identity.js';
import { requireStoredNanoHostPhysicalEpoch } from './nanohost-runtime-target.js';
import type { WorkerBackendSessionRecord } from './worker-backend-session-records.js';

/** Core identity projection only; optional historical backend metadata is read after capture presence. */
type NanoHostCaptureAnchorHint = Pick<
  WorkerBackendSessionRecord,
  | 'attemptId'
  | 'workspaceId'
  | 'packageSnapshotId'
  | 'backendSessionId'
  | 'runtimeTargetId'
  | 'originPhysicalEpoch'
  | 'agentSessionId'
  | 'sandboxBindingRef'
>;

/** Joins original backend identities to one current physical Sandbox lifetime without opening a Workspace. */
export function readNanoHostWorkspaceCaptureAnchors(
  coreDb: CoreDb,
  sandboxBindingRef: string
): NanoHostCaptureAnchorHint[] {
  const anchors = coreDb.sqlite
    .prepare(`SELECT schema_version AS schemaVersion, attempt_id AS attemptId,
      workspace_id AS workspaceId, package_snapshot_id AS packageSnapshotId,
      backend_session_id AS backendSessionId, runtime_target_id AS runtimeTargetId,
      origin_physical_epoch AS originPhysicalEpoch, agent_session_id AS agentSessionId,
      sandbox_binding_ref AS sandboxBindingRef FROM worker_backend_sessions ORDER BY attempt_id`)
    .all() as Array<NanoHostCaptureAnchorHint & { schemaVersion: unknown }>;
  for (const anchor of anchors) {
    readRetainedV1(anchor, () => anchor);
    requireStoredNanoHostPhysicalEpoch(anchor.originPhysicalEpoch);
    if (
      Object.entries(anchor).some(
        ([key, value]) => key !== 'schemaVersion' && (typeof value !== 'string' || !value)
      )
    )
      throw new Error('Workspace capture backend identity is invalid.');
  }
  const original = anchors.find((anchor) => anchor.sandboxBindingRef === sandboxBindingRef);
  const residents = coreDb.sqlite
    .prepare(`SELECT sandbox_runtime_id AS id,
      sandbox_binding_ref AS binding, runtime_target_id AS target,
      origin_physical_epoch AS epoch, sandbox_compatibility_key AS compatibility
      FROM sandbox_runtime_records WHERE sandbox_binding_ref=?
        OR (runtime_target_id=? AND origin_physical_epoch=?)`)
    .all(
      sandboxBindingRef,
      original?.runtimeTargetId ?? null,
      original?.originPhysicalEpoch ?? null
    ) as Array<{
    id: string;
    binding: string;
    target: string;
    epoch: string;
    compatibility: string;
  }>;
  const resident = residents.find(
    (row) =>
      row.binding === sandboxBindingRef ||
      (original &&
        nanoHostSandboxId(row.compatibility) ===
          nanoHostSandboxIdFromBackendSessionId(original.backendSessionId))
  );
  if (!resident && !original) return [];
  const target = resident?.target ?? original!.runtimeTargetId;
  const epoch = resident?.epoch ?? original!.originPhysicalEpoch;
  const sandboxId = resident
    ? nanoHostSandboxId(resident.compatibility)
    : nanoHostSandboxIdFromBackendSessionId(original!.backendSessionId);
  const sessions = resident
    ? new Set(
        (
          coreDb.sqlite
            .prepare(`SELECT b.agent_session_id AS id
      FROM agent_session_runtime_bindings b JOIN harness_instance_records h
        ON h.harness_instance_id=b.harness_instance_id WHERE h.sandbox_runtime_id=?`)
            .all(resident.id) as Array<{ id: string }>
        ).map((row) => row.id)
      )
    : null;
  // Attempt bindings differ across current siblings; proved deletion removes their runtime
  // bindings, so an old abandoned source cannot gate a later same-name Sandbox incarnation.
  return anchors.filter(
    (anchor) =>
      anchor.runtimeTargetId === target &&
      anchor.originPhysicalEpoch === epoch &&
      nanoHostSandboxIdFromBackendSessionId(anchor.backendSessionId) === sandboxId &&
      (!sessions || sessions.has(anchor.agentSessionId) || anchor.attemptId === original?.attemptId)
  );
}

/** Derives the existing physical Sandbox identity from its reuse key. */
export function nanoHostSandboxId(sandboxCompatibilityKey: string): string {
  return `nh-${sandboxCompatibilityKey.slice(0, 16)}`;
}
