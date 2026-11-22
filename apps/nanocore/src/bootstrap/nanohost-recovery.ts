import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import type { AdmittedNanoHostAttemptRecovery } from '../runtime/nanohost-attempt-recovery.js';
import {
  getNanoHostRuntimeTarget,
  type NanoHostRuntimeTargetRecord,
} from '../runtime/nanohost-runtime-target-records.js';
import type { WorkerBackendSessionRecord } from '../runtime/worker-backend-session-records.js';
import type { WorkerGovernanceBackendSessionIdentity } from '../runtime/worker-governance-backend.js';
import { ControlProductPreconditionError } from '../storage/control-store-product-records.js';
import type { NanoHostOwnerBinding } from '../storage/control-store-worker-client.js';
import {
  inspectAcceptedNanoHostFinalInDb,
  isAcceptedNanoHostFinalReceiptAbsent,
  type NanoHostAcceptedFinalCommitment,
} from '../storage/core-journal-native.js';
import type { CoreDb } from '../storage/db.js';
import {
  type NanoHostRecoveryLease,
  readNanoHostPhysicalCleanupReceipt,
  readNanoHostRecoveryLease,
} from '../storage/nanohost-recovery-native.js';
import { readRetainedNanoHostSubmission } from '../storage/nanohost-submitted-lease.js';

/** The existing lifecycle owners that Boot recovery joins. */
export interface BootNanoHostRecoveryOwners {
  readonly coreDb: CoreDb;
  /** The existing restart closeout owner. Its guarded read rechecks the same commitment. */
  readonly reconcileAcceptedFinalStatus: (
    session: WorkerBackendSessionRecord,
    commitment: NanoHostAcceptedFinalCommitment
  ) => Promise<unknown>;
  /** The existing physical close/delete transport of the lifecycle runtime. */
  readonly cleanupBackendSession: (
    identity: WorkerGovernanceBackendSessionIdentity
  ) => Promise<void>;
  /** Live lifecycle ownership of a Turn. A live owner keeps its own closeout and cleanup. */
  readonly isTurnExecutionActive: (turnId: string) => boolean;
}

/**
 * K8b first cleanup, the last safe point before contact. The claim on the existing Native row, the
 * pinned target, the original Core closing decision and the final evidence must all still hold.
 * Returns the exact claimed row, or null when any fact changed or is unknown.
 */
function readFirstCleanupClaim(
  coreDb: CoreDb,
  sqlite: Database.Database,
  claim: {
    readonly identity: WorkerGovernanceBackendSessionIdentity;
    readonly target: NanoHostRuntimeTargetRecord;
    readonly lease: NanoHostRecoveryLease;
    readonly observedAt: string;
  }
) {
  const { identity, target, lease } = claim;
  const { session, proof } = readNanoHostRecoveryLease(sqlite, lease);
  if (
    session.state !== 'cleanup-pending' ||
    identity.agentSessionId !== session.agentSessionId ||
    identity.backendKind !== session.backendKind ||
    identity.backendSessionId !== session.backendSessionId ||
    identity.deploymentId !== session.deploymentId ||
    identity.packageSnapshotId !== session.packageSnapshotId ||
    identity.runtimeTargetId !== session.runtimeTargetId ||
    identity.stagingDirectoryRef !== session.stagingDirectoryRef ||
    identity.transientProviderInstanceId !== session.transientProviderInstanceId ||
    !isDeepStrictEqual(getNanoHostRuntimeTarget({ sqlite }, session.runtimeTargetId), target) ||
    // The original Core closing decision, unchanged since recovery took the claim.
    !isDeepStrictEqual(
      readRetainedNanoHostSubmission(coreDb, lease.grant.attemptId)?.lease,
      lease
    ) ||
    lease.attempt.phase !== 'closing' ||
    lease.attempt.fenceRef !== null
  )
    return null;
  const nativeFinal = sqlite
    .prepare(`SELECT 1 FROM worker_control_records
      WHERE agent_session_id=? AND package_snapshot_id=? AND operation='final_status'
      UNION ALL SELECT 1 FROM worker_control_sequence_fingerprints
      WHERE agent_session_id=? AND package_snapshot_id=? AND operation='final_status' LIMIT 1`)
    .get(
      session.agentSessionId,
      session.packageSnapshotId,
      session.agentSessionId,
      session.packageSnapshotId
    );
  if (!nativeFinal)
    return isAcceptedNanoHostFinalReceiptAbsent(coreDb, lease.grant.attemptId, session.deploymentId)
      ? { session, proof }
      : null;
  // A8 Native-only pair: cleanup waits for the original absolute deadline. A settled receipt goes to
  // the guarded closeout, and held proof never cleans.
  const final = inspectAcceptedNanoHostFinalInDb(coreDb, sqlite, lease.grant.attemptId);
  return final.state === 'native-only' && lease.grant.deadline <= claim.observedAt
    ? { session, proof }
    : null;
}

/** Uses the same acknowledged owner that fenced the RuntimeTarget before serving. */
export function bindBootNanoHostAttemptRecovery(
  owner: NanoHostOwnerBinding,
  owners: BootNanoHostRecoveryOwners
): AdmittedNanoHostAttemptRecovery {
  const hold = { state: 'unavailable', owner: 'nanohost', reason: 'recovery-required' } as const;
  return {
    owner,
    close: owner.closeRecovery,
    commit: async (input) => {
      if (input.kind === 'retire-orphan') return hold;
      return owner.classifyRecovery(
        input as Parameters<NanoHostOwnerBinding['classifyRecovery']>[0]
      );
    },
    reconcileFinal: async (lease, session) => {
      // K8b: one inspect-only join of the Native final pair with the original Core intake and receipt.
      const read = owner.read((sqlite) =>
        inspectAcceptedNanoHostFinalInDb(owners.coreDb, sqlite, lease.grant.attemptId)
      );
      // Unavailable, missing, duplicate or contradictory proof holds with the recovery diagnostic.
      if (read.state !== 'ready' || read.value.state === 'held')
        throw new ControlProductPreconditionError();
      if (read.value.state === 'native-only') return 'native-only';
      await owners.reconcileAcceptedFinalStatus(session, read.value);
      return 'closed';
    },
    // K8b first cleanup: one target-pinned contact for the claimed row, through the existing transport.
    cleanup: async (identity, target, lease, now) => {
      const observedAt = now();
      const claim = owner.read((sqlite) =>
        sqlite
          .transaction(() =>
            readFirstCleanupClaim(owners.coreDb, sqlite, { identity, target, lease, observedAt })
          )
          .deferred()
      );
      // Changed, unreadable or conflicting proof, or a live owner of the Turn, holds with zero contact.
      if (
        claim.state !== 'ready' ||
        !claim.value ||
        owners.isTurnExecutionActive(lease.grant.turnId)
      )
        return hold;
      const expected = {
        lease,
        expectedSession: claim.value.session,
        expectedRecovery: claim.value.proof,
      };
      try {
        await owners.cleanupBackendSession(identity);
      } catch (error) {
        // The contact is uncertain. The failed claim is never resent and holds for the operator.
        await owner.classifyRecovery({
          ...expected,
          kind: 'transition',
          toState: 'cleanup-failed',
          target,
          observedAt: now(),
        });
        throw error;
      }
      // The Native writer compares the original occurrence and the pinned target at settlement.
      const settled = await owner
        .classifyRecovery({
          ...expected,
          kind: 'transition',
          toState: 'physical-cleaned',
          target,
          observedAt: now(),
        })
        .catch(() => null);
      // The committed receipt is reread independently. A lost settlement ACK recovers it here.
      const receipt = owner.read((sqlite) =>
        readNanoHostPhysicalCleanupReceipt(sqlite, lease, target)
      );
      if (
        receipt.state !== 'ready' ||
        !receipt.value ||
        (settled?.state === 'ready' && !isDeepStrictEqual(settled.value, receipt.value.session))
      )
        return hold;
      return { state: 'ready', value: receipt.value };
    },
  };
}
