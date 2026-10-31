import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  RecoverDeletedWorkspaceResponseSchema,
  WorkspaceDeletionResponseSchema,
  type WorkspaceDeletionState,
} from '@openkit/app-api-schemas';
import { readRetainedV1 } from '@openkit/protocol';
import {
  listServerAuditEvents,
  listSqliteAuditEvents,
  recordServerAuditEvent,
} from './audit-events.js';
import type { Actor } from './auth/identity.js';
import {
  evaluateProductAuthorization,
  hasWorkspaceDeletionRetryAuthority,
  isCurrentDeploymentAdministrator,
  isWorkspaceOperationAuthorized,
} from './auth/operation-authorizer.js';
import { isCanonicalUserActive } from './auth/user-lifecycle.js';
import { isScopeAdmitted, refuseScope } from './bootstrap/readiness.js';
import type { FsStore } from './lib/store.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import type { OperationImplementations } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { commandInputHash } from './runtime/idempotent-command.js';
import type { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import { closeWorkspaceProductReadHandles } from './storage/control-store-products.js';
import { getControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { workspaceRecoveryCandidateDigest } from './storage/data-root-backup.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { readDataRootLayoutMarker } from './storage/fs-layout.js';
import {
  createWorkspaceBackup,
  readBlockers,
  readWorkspaceRecoveryBlockers,
  WORKSPACE_BACKUP_POLICY,
} from './storage/workspace-backup.js';
import {
  readWorkspaceSnapshotMetadata,
  withVerifiedWorkspaceSnapshotSource,
} from './storage/workspace-backup-bundle.js';
import {
  assertCanonicalDirectory,
  assertCanonicalRegularFile,
  readNativeProduct,
  WorkspaceSystemRecordSchema,
} from './storage/workspace-file-records.js';
import type { RecoveryAdmission } from './storage/workspace-recovery-admissions.js';
import {
  bindWorkspaceDeletionNativeOwner,
  bindWorkspaceRecoveryReadmissionNativeOwner,
  readRecoveryAdmission,
  resumeWorkspaceRecoveryOwner,
} from './storage/workspace-recovery-admissions.js';
import {
  activateWorkspaceRecoveryAtCore,
  admitWorkspaceBackupAtCore,
} from './storage/workspace-restore.js';
import {
  createWorkspaceDeletionClosure,
  existingWorkspaceDeletionClosureRoot,
  listWorkspaceDeletionHoldRecordIds,
  verifyWorkspaceDeletionClosure,
} from './workspace-deletion-evidence.js';
import {
  createWorkspaceDeletionRequest,
  isTerminalWorkspaceDeletionRequest,
  listWorkspaceDeletionRequests,
  readWorkspaceDeletionRequest,
  type WorkspaceDeletionRequestRecord,
  workspaceDeletionStagingRelativePath,
  writeWorkspaceDeletionRequest,
} from './workspace-deletion-request.js';
import { resolveWorkspaceMembershipRelation } from './workspace-membership.js';
import type {
  WorkspaceFrozenAdmission,
  WorkspaceMutationAdmission,
} from './workspace-mutation-admission.js';
import {
  beginWorkspaceDeletion,
  completeWorkspaceDeletion,
  getWorkspaceRegistryLifecycleFact,
} from './workspace-sharing.js';

const CORE_RECEIPT_OWNER = { coreId: 'server' } as const;

/** Joins exact deletion requests and tombstone recovery to their existing lifecycle owners. */
export function createWorkspaceDeletionOperationImplementations(
  input: Pick<
    OperationInvocationDependencies,
    | 'coreDb'
    | 'dataRoot'
    | 'fileAdmission'
    | 'workspaceMutationAdmission'
    | 'closeWorkspaceMcpSessions'
    | 'repositoryWorkspaceDb'
    | 'store'
    | 'runtimeConfigManager'
    | 'diagnosticsServices'
  >
) {
  return {
    'workspace.delete': async (value, context) => {
      const coreDb = input.coreDb;
      const dataRoot = input.dataRoot;
      const fileAdmission = input.fileAdmission;
      if (!coreDb || !dataRoot || !fileAdmission)
        throw new OperationError(
          'workspace_deletion_unavailable',
          'Workspace deletion is unavailable.',
          503
        );
      if (
        value.confirmation !==
        `permanently-delete-workspace:${value.workspaceId}:${value.expectedRegistryRevision}`
      )
        throw new OperationError(
          'invalid_request',
          'Workspace deletion confirmation does not match the request path.',
          400
        );
      if (context.kind !== 'public')
        throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
      try {
        const gate = input.workspaceMutationAdmission!;
        const deletionInput = {
          actorId: context.actor.userId,
          actor: context.actor,
          administratorEligible: isCurrentDeploymentAdministrator(coreDb, context.actor),
          closeWorkspaceMcpSessions: input.closeWorkspaceMcpSessions!,
          coreDb,
          dataRoot,
          mutationAdmission: input.workspaceMutationAdmission!,
          fileAdmission,
          repositoryWorkspaceDb: input.repositoryWorkspaceDb!,
          request: {
            confirmation: value.confirmation,
            expectedRegistryRevision: value.expectedRegistryRevision,
            requestId: value.requestId,
          },
          store: input.store!,
          workspaceId: value.workspaceId,
        };
        const existing = selectDeletionRequest(deletionInput, false);
        let freeze: WorkspaceFrozenAdmission | undefined;
        if (!existing || !['blocked', 'cleaned'].includes(existing.phase)) {
          const inspect = () => {
            if (existing?.phase === 'deleted') {
              requireTerminalDeletionTruth(
                { coreDb, store: input.store!, workspaceId: value.workspaceId },
                existing
              );
              requireTerminalWorkspaceStorage(dataRoot, existing);
              return [];
            }
            if (existing && !['requested', 'fenced'].includes(existing.phase)) {
              requireDeletingRegistry(coreDb, existing);
              if (!existsSync(join(dataRoot, 'workspaces', value.workspaceId))) {
                requireExactStagedWorkspace(dataRoot, existing);
                return [];
              }
              return readBlockers({
                coreDb,
                store: input.store!,
                workspaceId: value.workspaceId,
                operation: 'delete',
              });
            }
            return readBlockers({
              coreDb,
              store: input.store!,
              workspaceId: value.workspaceId,
              operation: 'capture',
              ...(existing ? { deletionRequest: existing } : {}),
            });
          };
          const admitted =
            existing && gate.isClosed(value.workspaceId, 'capture')
              ? gate.tryResumeRecovery(
                  value.workspaceId,
                  {
                    deletionRequestId: existing.requestId,
                    revision: existing.expectedRegistryRevision,
                  },
                  inspect
                )
              : gate.tryFreeze(value.workspaceId, inspect);
          if (admitted.status !== 'frozen')
            throw new OperationError(
              admitted.status === 'busy' ? 'workspace_frozen' : 'workspace_blocked',
              'Workspace deletion is not admitted.',
              409,
              {
                details: {
                  workspaceId: value.workspaceId,
                  operation: 'delete',
                  retryable: admitted.status === 'busy',
                  blockers:
                    admitted.status === 'blocked'
                      ? admitted.blockers
                      : [
                          {
                            kind: 'publication',
                            reason: 'frozen',
                            reference: { workspaceId: value.workspaceId },
                            actions: [],
                          },
                        ],
                },
              }
            );
          freeze = admitted;
        }
        try {
          const result = await advanceWorkspaceDeletion({
            ...deletionInput,
            freezeOwner: freeze,
            release: input.diagnosticsServices?.releaseIdentity,
          });
          context.observeSuccessStatus?.(result.status);
          return result.body;
        } finally {
          if (freeze && gate.ownsFreeze(value.workspaceId, freeze)) {
            const retained = listWorkspaceDeletionRequests(dataRoot, value.workspaceId).find(
              (r) => r.requestId === value.requestId
            );
            if (retained && retained.phase !== 'blocked')
              gate.restoreRecoveryClosed(value.workspaceId, {
                deletionRequestId: retained.requestId,
                revision: retained.expectedRegistryRevision,
              });
            freeze.release();
          }
        }
      } catch (error) {
        if (error instanceof OperationError) throw error;
        throw recoveryRequired();
      }
    },
    'workspace.deleted-recover': async (value, context) => {
      const coreDb = input.coreDb;
      const dataRoot = input.dataRoot;
      const fileAdmission = input.fileAdmission;
      if (!coreDb || !dataRoot || !fileAdmission)
        throw new OperationError(
          'workspace_recovery_unavailable',
          'Deleted Workspace recovery is unavailable.',
          503
        );
      const accessDenied = new OperationError(
        'workspace_access_denied',
        'Workspace access denied.',
        403
      );
      if (context.kind !== 'public') throw accessDenied;
      const actor = context.actor;
      const workspaceId = value.workspaceId;
      try {
        return await recoverOriginalDeletedWorkspace(input, {
          actor,
          workspaceId,
          requestId: value.requestId,
          deletionRequestId: value.deletionRequestId,
          accessDenied,
        });
      } catch (error) {
        if (error instanceof OperationError) throw error;
        throw new OperationError(
          'recovery_required',
          'Deleted Workspace recovery requires operator inspection.',
          409
        );
      }
    },
  } satisfies Pick<OperationImplementations, 'workspace.delete' | 'workspace.deleted-recover'>;
}

/** Restores one original tombstone through the existing target admission and serving activation. */
async function recoverOriginalDeletedWorkspace(
  input: Parameters<typeof createWorkspaceDeletionOperationImplementations>[0],
  value: {
    actor: Actor;
    workspaceId: string;
    requestId: string;
    deletionRequestId: string;
    accessDenied: OperationError;
  }
) {
  const { actor, workspaceId, requestId } = value;
  const {
    coreDb: core,
    dataRoot,
    store,
    fileAdmission,
    workspaceMutationAdmission: gate,
    runtimeConfigManager: manager,
  } = input;
  if (!core || !dataRoot || !store || !fileAdmission || !gate || !manager) throw recoveryRequired();
  const deletion = readWorkspaceDeletionRequest(dataRoot, workspaceId, value.deletionRequestId);
  if (!['deleted', 'cleaned'].includes(deletion.phase)) throw recoveryRequired();
  const currentAuthority = () => {
    if (
      evaluateProductAuthorization(
        core,
        actor,
        { kind: 'workspace', workspaceId, deletedRecovery: true },
        'workspace.write',
        true
      ).effect !== 'allow'
    )
      throw value.accessDenied;
    const actual = readWorkspaceDeletionRequest(dataRoot, workspaceId, value.deletionRequestId);
    if (!isDeepStrictEqual(actual, deletion)) throw recoveryRequired();
    const previous = readRecoveryAdmission(core, requestId);
    if (
      previous &&
      (previous.workspace_id !== workspaceId ||
        previous.backup_id !== deletion.recoveryBackupId ||
        previous.proof.capture.manifestDigest !== deletion.recoveryBackupManifestDigest ||
        previous.proof.manifest.accounts.ownerId !== deletion.originalOwnerUserId ||
        previous.proof.input.command !== 'restore' ||
        previous.proof.input.acknowledgeLostSafety)
    )
      throw recoveryRequired();
    requireTerminalDeletionTruth(
      { coreDb: core, store, workspaceId, ...(previous ? { recovery: previous } : {}) },
      deletion
    );
  };
  currentAuthority();
  const previous = readRecoveryAdmission(core, requestId);
  const project = (
    report: import('./storage/workspace-recovery-cli.js').WorkspaceRecoveryCliReport
  ) =>
    RecoverDeletedWorkspaceResponseSchema.parse({
      command: 'restore',
      disposition: report.disposition,
      workspaceId,
      currentRevision: report.currentRevision,
      selection: { kind: 'admission', requestId },
      droppedSourceMemberIds: [],
      restrictedRecovery: false,
      nextAction: report.nextAction,
    });
  if (
    previous?.state === 'finished' &&
    isScopeAdmitted(dataRoot, 'workspace', workspaceId) &&
    !gate.isClosed(workspaceId)
  )
    return project(previous.proof.result);
  // A resumed native open may normalize SQLite sidecars, never unreviewed candidate bytes.
  if (
    previous?.state === 'finished' &&
    (!previous.proof.candidateDigest ||
      workspaceRecoveryCandidateDigest(join(dataRoot, 'workspaces', workspaceId)) !==
        previous.proof.candidateDigest)
  )
    throw recoveryRequired();
  if (!previous) requireTerminalWorkspaceStorage(dataRoot, deletion);
  const verified = await verifyDeletionArtifacts(dataRoot, deletion);
  currentAuthority();
  const inspect = () =>
    readWorkspaceRecoveryBlockers(
      { coreDb: core, store, workspaceId, operation: 'restore' },
      { deletionRequest: deletion, ...(previous ? { admission: previous } : {}) }
    );
  let hold: Promise<() => void> | null = null;
  const inspectAndHold = () => {
    const blockers = inspect();
    if (blockers.length) return blockers;
    hold = getControlStoreWorkerClient(gate).tryPauseForWorkspaceCapture(
      `workspace:${join(dataRoot, 'workspaces', workspaceId, 'db/workspace.sqlite')}`,
      gate
    );
    return hold
      ? []
      : [
          {
            kind: 'publication' as const,
            reason: 'pending-publication' as const,
            reference: { workspaceId },
            actions: [],
          },
        ];
  };
  const deletionOrigin = {
    deletionRequestId: deletion.requestId,
    revision: deletion.expectedRegistryRevision,
  };
  const freeze = previous
    ? resumeWorkspaceRecoveryOwner(core, previous, gate, inspectAndHold)
    : gate.tryResumeRecovery(workspaceId, deletionOrigin, inspectAndHold);
  if (freeze.status !== 'frozen')
    throw new OperationError(
      freeze.status === 'busy' ? 'workspace_frozen' : 'workspace_blocked',
      'Deleted Workspace recovery is not admitted.',
      409,
      {
        details: {
          workspaceId,
          operation: 'restore',
          retryable: freeze.status === 'busy',
          blockers:
            freeze.status === 'blocked'
              ? freeze.blockers
              : [
                  {
                    kind: 'publication',
                    reason: 'frozen',
                    reference: { workspaceId },
                    actions: [],
                  },
                ],
        },
      }
    );
  try {
    if (!hold) throw recoveryRequired();
    const release = await (hold as Promise<() => void>);
    try {
      currentAuthority();
      if (inspect().length) throw recoveryRequired();
    } finally {
      release();
    }
    const owner = {
      core,
      fileAdmission,
      currentAuthority,
      native: { gate, freeze },
      deletedRecovery: { deletion, actorId: actor.userId },
    };
    refuseScope(dataRoot, { scope: 'workspace', id: workspaceId, check: 'recovery' });
    await admitWorkspaceBackupAtCore(owner, {
      command: 'restore',
      dataRoot,
      bundleRoot: join(
        dataRoot,
        'server/backups/workspaces',
        workspaceId,
        deletion.recoveryBackupId!
      ),
      workspaceId,
      requestId,
      acknowledgeLostSafety: false,
      expectedRelease: verified.manifest.release,
      snapshotSource: {
        dataRoot,
        source: { kind: 'local-snapshot', workspaceId, backupId: deletion.recoveryBackupId! },
      },
    });
    currentAuthority();
    const completed = readRecoveryAdmission(core, requestId)!;
    if (!previous)
      gate.transferDeletionRecovery(workspaceId, freeze, deletionOrigin, {
        admissionId: requestId,
        revision: completed.revision - 1,
        candidateRef: completed.candidate_ref,
      });
    if (previous) {
      // A resumed census can leave WAL readers. Reuse the native close boundary before the byte seal.
      const binding = bindWorkspaceRecoveryReadmissionNativeOwner(core, completed, gate, freeze);
      const client = getControlStoreWorkerClient(gate);
      await client.open(binding.binding.command, binding);
      try {
        currentAuthority();
      } finally {
        await client.close(binding.binding.command.database, binding);
      }
      currentAuthority();
    }
    return project(
      activateWorkspaceRecoveryAtCore(owner, {
        requestId,
        store,
        runtimeConfigManager: manager,
        currentAuthority,
      })
    );
  } catch (error) {
    const retained = readRecoveryAdmission(core, requestId);
    if (
      retained &&
      retained.workspace_id === workspaceId &&
      retained.backup_id === deletion.recoveryBackupId &&
      retained.proof.capture.manifestDigest === deletion.recoveryBackupManifestDigest &&
      retained.state !== 'abandoned'
    ) {
      gate.restoreRecoveryClosed(workspaceId, {
        admissionId: requestId,
        revision: retained.revision - (retained.state === 'finished' ? 1 : 0),
        candidateRef: retained.candidate_ref,
      });
      // A truthful pending response requires the exact still-sealed candidate, never a catch-all promise.
      const target = existsSync(retained.candidate_ref)
        ? retained.candidate_ref
        : join(dataRoot, 'workspaces', workspaceId);
      if (retained.proof.candidateDigest) {
        try {
          currentAuthority();
          if (workspaceRecoveryCandidateDigest(target) === retained.proof.candidateDigest)
            return RecoverDeletedWorkspaceResponseSchema.parse({
              command: 'restore',
              disposition: 'pending',
              workspaceId,
              selection: { kind: 'admission', requestId },
              droppedSourceMemberIds: [],
              restrictedRecovery: false,
              nextAction: 'finish',
            });
        } catch {
          /* Preserve the original failure when exact continuation cannot be proved. */
        }
      }
    }
    throw error;
  } finally {
    freeze.release();
  }
}

/** Advances only the exact request-owned deletion phases; no ordinary Workspace content authority survives fencing. */
async function advanceWorkspaceDeletion(input: {
  actorId: string;
  actor: Actor;
  administratorEligible: boolean;
  closeWorkspaceMcpSessions: (workspaceId: string) => Promise<void>;
  coreDb: CoreDb;
  dataRoot: string;
  mutationAdmission: WorkspaceMutationAdmission;
  fileAdmission: FileStorageAdmission;
  repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  request: { confirmation: string; expectedRegistryRevision: number; requestId: string };
  store: FsStore;
  workspaceId: string;
  freezeOwner?: WorkspaceFrozenAdmission | undefined;
  release?:
    | { readonly sourceCommit?: string | null; readonly releaseTag?: string | null }
    | null
    | undefined;
}): Promise<{ body: ReturnType<typeof WorkspaceDeletionResponseSchema.parse>; status: 200 }> {
  let request = selectDeletionRequest(input)!;
  if (request.phase === 'blocked') {
    requireActiveBlockedRegistry(input.coreDb, request);
    return { body: deletionResponse(request), status: 200 };
  }
  if (request.phase === 'cleaned') {
    requireTerminalWorkspaceStorage(input.dataRoot, request);
    requireTerminalDeletionTruth(input, request);
    await verifyDeletionArtifacts(input.dataRoot, request);
    return { body: deletionResponse(request), status: 200 };
  }
  if (
    !input.freezeOwner ||
    !input.mutationAdmission.ownsFreeze(input.workspaceId, input.freezeOwner)
  )
    throw recoveryRequired();
  await input.closeWorkspaceMcpSessions(input.workspaceId);
  // Cleanup can yield to revocation, so check authority before advancing the request.
  if (request.phase === 'requested' || request.phase === 'fenced') {
    const registry = getWorkspaceRegistryLifecycleFact(input.coreDb, input.workspaceId);
    const activeActor =
      registry?.status === 'active' &&
      registry.ownerUserId === request.originalOwnerUserId &&
      registry.registryRevision === request.expectedRegistryRevision &&
      isWorkspaceOperationAuthorized(input.coreDb, input.actor, input.workspaceId, {
        mutating: true,
        policyOperation: 'workspace.lifecycle',
      });
    const retryActor =
      request.phase === 'fenced' &&
      registry?.status === 'deleting' &&
      registry.ownerUserId === request.originalOwnerUserId &&
      registry.registryRevision === request.expectedRegistryRevision + 1 &&
      hasWorkspaceDeletionRetryAuthority(input.coreDb, input.actor, input.workspaceId, {
        dataRoot: input.dataRoot,
        requestId: request.requestId,
      });
    if (!activeActor && !retryActor) throw recoveryRequired();
  } else if (
    !hasWorkspaceDeletionRetryAuthority(input.coreDb, input.actor, input.workspaceId, {
      dataRoot: input.dataRoot,
      requestId: request.requestId,
    })
  )
    throw recoveryRequired();
  if (!isCanonicalUserActive(input.coreDb, request.originalOwnerUserId)) {
    if (['requested', 'fenced'].includes(request.phase)) {
      request = persistDeletionPhase(input.dataRoot, request, { phase: 'blocked' });
      input.mutationAdmission.reopen(input.workspaceId, 'capture');
      input.mutationAdmission.reopen(input.workspaceId);
      return { body: deletionResponse(request), status: 200 };
    }
    throw recoveryRequired();
  }
  if (request.phase === 'requested') {
    request = persistDeletionPhase(input.dataRoot, request, { phase: 'fenced' });
  }
  if (request.phase === 'fenced') {
    const registry = getWorkspaceRegistryLifecycleFact(input.coreDb, input.workspaceId);
    if (
      registry?.status === 'deleting' &&
      registry.ownerUserId === request.originalOwnerUserId &&
      registry.registryRevision === request.expectedRegistryRevision + 1
    ) {
      await verifyRecoveryBackup(input.dataRoot, request);
      request = persistDeletionPhase(input.dataRoot, request, { phase: 'deleting' });
    }
  }
  if (request.phase === 'staged') {
    requireExactStagedWorkspace(input.dataRoot, request);
    const registry = getWorkspaceRegistryLifecycleFact(input.coreDb, input.workspaceId);
    if (
      registry?.status === 'deleted' &&
      registry.ownerUserId === request.originalOwnerUserId &&
      registry.registryRevision === request.expectedRegistryRevision + 2
    ) {
      const terminal = requireTerminalDeletionTruth(input, request);
      request = persistDeletionPhase(input.dataRoot, request, {
        phase: 'deleted',
        terminalAuditEventId: terminal.auditEventId,
        commandReceiptKey: terminal.commandReceiptKey,
      });
    }
  }
  if (request.phase === 'fenced') {
    const holdRecordIds = deletionHoldRecordIds(input.repositoryWorkspaceDb, input.workspaceId);
    if (holdRecordIds.length > 0) {
      persistDeletionPhase(input.dataRoot, request, { phase: 'blocked' });
      input.mutationAdmission.reopen(input.workspaceId, 'capture');
      input.mutationAdmission.reopen(input.workspaceId);
      throw new OperationError(
        'workspace_deletion_blocked',
        'Workspace deletion is blocked by legal hold.',
        409,
        { details: { holdRecordIds } }
      );
    }
  }
  if (request.phase === 'fenced') {
    const backupId = request.recoveryBackupId!;
    const bundleRoot = join(
      input.dataRoot,
      'server/backups/workspaces',
      input.workspaceId,
      backupId
    );
    const currentAuthority = () => {
      const row = getWorkspaceRegistryLifecycleFact(input.coreDb, input.workspaceId);
      if (
        !input.mutationAdmission.ownsFreeze(input.workspaceId, input.freezeOwner!) ||
        row?.status !== 'active' ||
        row.ownerUserId !== request.originalOwnerUserId ||
        row.registryRevision !== request.expectedRegistryRevision ||
        !isWorkspaceOperationAuthorized(input.coreDb, input.actor, input.workspaceId, {
          mutating: true,
          policyOperation: 'workspace.lifecycle',
        })
      )
        throw recoveryRequired();
    };
    currentAuthority();
    if (!input.release?.sourceCommit)
      throw new OperationError(
        'operation_storage_unavailable',
        'The server build identity is unavailable.',
        503
      );
    const verification = {
      ...WORKSPACE_BACKUP_POLICY,
      stagingParent: join(input.dataRoot, 'server/backups'),
      admission: input.fileAdmission,
      expectedRelease: {
        version: input.release.releaseTag ?? 'source',
        buildId: input.release.sourceCommit,
      },
    };
    if (!existsSync(join(bundleRoot, 'seal.json'))) {
      await createWorkspaceBackup({
        ...verification,
        bundleRoot,
        workspaceId: input.workspaceId,
        backupId,
        purpose: 'backup',
        expectedSourceDeploymentId: readDataRootLayoutMarker(input.dataRoot).deploymentId,
        source: {
          kind: 'live-workspace',
          dataRoot: input.dataRoot,
          coreDb: input.coreDb,
          store: input.store,
          mutationAdmission: input.mutationAdmission,
          freezeOwner: input.freezeOwner,
          deletionRequest: request,
          currentAuthority,
        },
      });
    }
    const verified = await withVerifiedWorkspaceSnapshotSource(
      {
        ...verification,
        dataRoot: input.dataRoot,
        source: { kind: 'local-snapshot', workspaceId: input.workspaceId, backupId },
      },
      async (bundle) => ({ manifest: bundle.manifest, manifestDigest: bundle.manifestDigest })
    );
    currentAuthority();
    if (
      request.recoveryBackupManifestDigest !== null &&
      request.recoveryBackupManifestDigest !== verified.manifestDigest
    )
      throw recoveryRequired();
    if (
      verified.manifest.accounts.ownerId !== request.originalOwnerUserId ||
      verified.manifest.sourceDeploymentId !==
        readDataRootLayoutMarker(input.dataRoot).deploymentId ||
      verified.manifest.purpose !== 'backup'
    )
      throw recoveryRequired();
    const holds = deletionHoldRecordIds(input.repositoryWorkspaceDb, input.workspaceId);
    if (holds.length || !isCanonicalUserActive(input.coreDb, request.originalOwnerUserId)) {
      request = persistDeletionPhase(input.dataRoot, request, {
        phase: 'blocked',
        recoveryBackupManifestDigest: null,
      });
      input.mutationAdmission.reopen(input.workspaceId, 'capture');
      throw new OperationError(
        'workspace_deletion_blocked',
        'Workspace deletion is blocked.',
        409,
        { details: { holdRecordIds: holds } }
      );
    }
    // The final-cut pointer is durable before the active registry can change.
    request = persistDeletionPhase(input.dataRoot, request, {
      recoveryBackupManifestDigest: verified.manifestDigest,
    });
    input.coreDb.sqlite.transaction(() =>
      beginWorkspaceDeletion({
        coreDb: input.coreDb,
        workspaceId: input.workspaceId,
        originalOwnerUserId: request.originalOwnerUserId,
        expectedRegistryRevision: request.expectedRegistryRevision,
      })
    )();
    request = persistDeletionPhase(input.dataRoot, request, {
      phase: 'exported',
      recoveryBackupId: backupId,
      recoveryBackupManifestDigest: verified.manifestDigest,
    });
  }
  if (['deleting', 'exported', 'closure-sealed', 'staged'].includes(request.phase))
    requireDeletingRegistry(input.coreDb, request);
  // A Core-fenced retry can only reuse the exact final-cut identity published before the CAS.
  if (request.phase === 'deleting') {
    await verifyRecoveryBackup(input.dataRoot, request);
    request = persistDeletionPhase(input.dataRoot, request, { phase: 'exported' });
  }
  if (request.phase === 'exported') {
    const verified = await verifyRecoveryBackup(input.dataRoot, request);
    const closureId = deletionClosureId(request.requestId);
    const closureRoot = join(
      input.dataRoot,
      'server',
      'exports',
      'workspace-closures',
      input.workspaceId,
      closureId
    );
    const closure = existsSync(closureRoot)
      ? verifyWorkspaceDeletionClosure({
          closureRoot: existingWorkspaceDeletionClosureRoot(
            input.dataRoot,
            input.workspaceId,
            closureId
          ),
          workspaceId: input.workspaceId,
          requestId: request.requestId,
          originalOwnerUserId: request.originalOwnerUserId,
          sourceRegistryRevision: request.expectedRegistryRevision + 1,
          closureId,
          recoveryBackupId: verified.manifest.backupId,
          recoveryBackupManifestDigest: verified.manifestDigest,
        })
      : createWorkspaceDeletionClosure({
          coreDb: input.coreDb,
          dataRoot: input.dataRoot,
          repositoryWorkspaceDb: input.repositoryWorkspaceDb,
          workspaceId: input.workspaceId,
          requestId: request.requestId,
          originalOwnerUserId: request.originalOwnerUserId,
          sourceRegistryRevision: request.expectedRegistryRevision + 1,
          closureId,
          cutoffTimestamp: new Date().toISOString(),
          recoveryBackupId: verified.manifest.backupId,
          recoveryBackupManifestDigest: verified.manifestDigest,
        });
    request = persistDeletionPhase(input.dataRoot, request, {
      phase: 'closure-sealed',
      closureId,
      closureDigest: closure.manifestDigest,
    });
  }
  if (request.phase === 'closure-sealed') {
    await verifyDeletionArtifacts(input.dataRoot, request);
    const stagingRelativePath = workspaceDeletionStagingRelativePath(
      input.workspaceId,
      request.requestId
    );
    const source = join(input.dataRoot, 'workspaces', input.workspaceId);
    const target = join(input.dataRoot, stagingRelativePath);
    const sourceExists = Boolean(lstatSync(source, { throwIfNoEntry: false }));
    const targetExists = Boolean(lstatSync(target, { throwIfNoEntry: false }));
    if (sourceExists === targetExists) {
      throw recoveryRequired();
    }
    if (sourceExists) {
      requireWorkspaceRootIdentity(source, input.workspaceId);
      const native = bindWorkspaceDeletionNativeOwner(
        input.coreDb,
        request,
        input.mutationAdmission,
        input.freezeOwner!
      );
      const client = getControlStoreWorkerClient(input.mutationAdmission);
      await client.open(native.binding.command, native);
      await client.close(native.binding.command.database, native);
      if (
        !input.mutationAdmission.ownsFreeze(input.workspaceId, input.freezeOwner!) ||
        !hasWorkspaceDeletionRetryAuthority(input.coreDb, input.actor, input.workspaceId, {
          dataRoot: input.dataRoot,
          requestId: request.requestId,
        })
      )
        throw recoveryRequired();
      requireDeletingRegistry(input.coreDb, request);
      mkdirPrivate(dirname(target));
      closeWorkspaceProductReadHandles(source);
      renameSync(source, target);
      fsyncDirectory(dirname(source));
      fsyncDirectory(dirname(target));
    } else {
      requireWorkspaceRootIdentity(target, input.workspaceId);
    }
    request = persistDeletionPhase(input.dataRoot, request, {
      phase: 'staged',
      stagingRelativePath,
    });
  }
  if (request.phase === 'staged') {
    requireExactStagedWorkspace(input.dataRoot, request);
    await verifyDeletionArtifacts(input.dataRoot, request);
    removeSupersededWorkspaceExports(input.dataRoot, request);
    const terminal = input.coreDb.sqlite.transaction(() => {
      const recurringAudit = listSqliteAuditEvents(input.coreDb.sqlite, input.workspaceId, true);
      const registry = completeWorkspaceDeletion({
        coreDb: input.coreDb,
        workspaceId: input.workspaceId,
        originalOwnerUserId: request.originalOwnerUserId,
        expectedRegistryRevision: request.expectedRegistryRevision + 1,
      });
      // The verified closure and recovery export now retain this exact Core-homed graph.
      // Remove children first; a failure rolls back the terminal registry transition too.
      input.coreDb.sqlite
        .prepare(`DELETE FROM external_trigger_admissions
        WHERE schedule_id IN (SELECT id FROM recurring_schedules WHERE workspace_id = ?)`)
        .run(input.workspaceId);
      for (const table of [
        'recurring_occurrences',
        'recurring_expired_ranges',
        'recurring_schedules',
      ])
        input.coreDb.sqlite
          .prepare(`DELETE FROM ${table} WHERE workspace_id = ?`)
          .run(input.workspaceId);
      for (const event of recurringAudit)
        input.coreDb.sqlite
          .prepare('DELETE FROM audit_events WHERE workspace_id = ? AND audit_event_id = ?')
          .run(input.workspaceId, event.id);
      const audit = recordServerAuditEvent({
        action: 'workspace.delete',
        actor: { id: input.actorId, kind: 'user' },
        category: 'command',
        coreDb: input.coreDb,
        outcome: 'succeeded',
        requestId: request.requestId,
        resource: `workspace:${input.workspaceId}`,
        resourceRevision: registry.registryRevision,
        summary: 'Workspace permanently deleted with verified recovery artifacts.',
        workspaceId: input.workspaceId,
      });
      const receipt = input.store.recordCommandRequest(
        {
          command: 'workspace.delete',
          requestId: request.requestId,
          scope: {
            ...CORE_RECEIPT_OWNER,
            actorId: input.actorId,
            targetWorkspaceId: input.workspaceId,
          },
          inputHash: commandInputHash(input.request),
          response: { kind: 'workspace_deletion', id: request.requestId },
        },
        input.coreDb
      );
      return { audit, receipt, registry };
    })();
    request = persistDeletionPhase(input.dataRoot, request, {
      phase: 'deleted',
      terminalAuditEventId: terminal.audit.id,
      commandReceiptKey: terminal.receipt.key,
    });
  }
  if (request.phase === 'deleted') {
    const stagingRoot = requireTerminalWorkspaceStorage(input.dataRoot, request);
    requireTerminalDeletionTruth(input, request);
    await verifyDeletionArtifacts(input.dataRoot, request);
    input.store.evictWorkspace(input.workspaceId);
    try {
      if (existsSync(stagingRoot)) {
        rmSync(stagingRoot, { recursive: true });
        fsyncDirectory(dirname(stagingRoot));
      }
      request = persistDeletionPhase(input.dataRoot, request, {
        phase: 'cleaned',
        retainedStaging: false,
        cleanedAt: new Date().toISOString(),
      });
    } catch {
      request = persistDeletionPhase(input.dataRoot, request, { retainedStaging: true });
    }
  }
  return { body: deletionResponse(request), status: 200 };
}

function selectDeletionRequest(
  input: {
    actorId: string;
    administratorEligible: boolean;
    coreDb: CoreDb;
    dataRoot: string;
    repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
    request: { confirmation: string; expectedRegistryRevision: number; requestId: string };
    workspaceId: string;
    store: FsStore;
  },
  create = true
): WorkspaceDeletionRequestRecord | undefined {
  let records: WorkspaceDeletionRequestRecord[];
  try {
    records = listWorkspaceDeletionRequests(input.dataRoot, input.workspaceId);
  } catch {
    throw recoveryRequired();
  }
  const nonterminal = records.filter((record) => !isTerminalWorkspaceDeletionRequest(record));
  if (nonterminal.length > 1) {
    throw recoveryRequired();
  }
  const existing = records.find((record) => record.requestId === input.request.requestId);
  if (existing) {
    if (
      (!input.administratorEligible && existing.initiatingUserId !== input.actorId) ||
      existing.expectedRegistryRevision !== input.request.expectedRegistryRevision ||
      existing.confirmation !== input.request.confirmation
    ) {
      throw new OperationError(
        'idempotency_key_conflict',
        'The requestId was already used for different command input.',
        409
      );
    }
    return existing;
  }
  if (nonterminal[0]) {
    throw new OperationError(
      'workspace_deletion_in_progress',
      'Another deletion request already owns this Workspace.',
      409,
      { details: deletionState(nonterminal[0]) }
    );
  }
  const registry = getWorkspaceRegistryLifecycleFact(input.coreDb, input.workspaceId);
  if (
    !registry ||
    registry.status !== 'active' ||
    (!input.administratorEligible &&
      !resolveWorkspaceMembershipRelation(input.coreDb, input.workspaceId, input.actorId)) ||
    registry.registryRevision !== input.request.expectedRegistryRevision
  ) {
    throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
  }
  if (input.store.getWorkspace(input.workspaceId).kind === 'personal')
    throw new OperationError(
      'personal_workspace_not_deletable',
      'Personal Workspaces cannot be deleted.',
      409
    );
  const holdRecordIds = deletionHoldRecordIds(input.repositoryWorkspaceDb, input.workspaceId);
  if (holdRecordIds.length > 0) {
    throw new OperationError(
      'workspace_deletion_blocked',
      'Workspace deletion is blocked by legal hold.',
      409,
      { details: { holdRecordIds } }
    );
  }
  if (!create) return undefined;
  return createWorkspaceDeletionRequest(input.dataRoot, {
    confirmation: input.request.confirmation,
    createdAt: new Date().toISOString(),
    expectedRegistryRevision: input.request.expectedRegistryRevision,
    originalOwnerUserId: registry.ownerUserId,
    initiatingUserId: input.actorId,
    requestId: input.request.requestId,
    workspaceId: input.workspaceId,
  });
}

async function verifyRecoveryBackup(dataRoot: string, request: WorkspaceDeletionRequestRecord) {
  if (!request.recoveryBackupId || !request.recoveryBackupManifestDigest) throw recoveryRequired();
  const verified = await readWorkspaceSnapshotMetadata({
    ...WORKSPACE_BACKUP_POLICY,
    dataRoot,
    workspaceId: request.workspaceId,
    backupId: request.recoveryBackupId,
  });
  if (
    verified.manifestDigest !== request.recoveryBackupManifestDigest ||
    verified.manifest.accounts.ownerId !== request.originalOwnerUserId ||
    verified.manifest.purpose !== 'backup'
  )
    throw recoveryRequired();
  return verified;
}

async function verifyDeletionArtifacts(dataRoot: string, request: WorkspaceDeletionRequestRecord) {
  const verified = await verifyRecoveryBackup(dataRoot, request);
  if (!request.closureId || !request.closureDigest) throw recoveryRequired();
  const closure = verifyWorkspaceDeletionClosure({
    closureRoot: existingWorkspaceDeletionClosureRoot(
      dataRoot,
      request.workspaceId,
      request.closureId
    ),
    workspaceId: request.workspaceId,
    requestId: request.requestId,
    originalOwnerUserId: request.originalOwnerUserId,
    sourceRegistryRevision: request.expectedRegistryRevision + 1,
    closureId: request.closureId,
    recoveryBackupId: verified.manifest.backupId,
    recoveryBackupManifestDigest: verified.manifestDigest,
  });
  if (closure.manifestDigest !== request.closureDigest) throw recoveryRequired();
  return verified;
}

function requireActiveBlockedRegistry(
  coreDb: CoreDb,
  request: WorkspaceDeletionRequestRecord
): void {
  const registry = getWorkspaceRegistryLifecycleFact(coreDb, request.workspaceId);
  if (
    !registry ||
    registry.status !== 'active' ||
    registry.ownerUserId !== request.originalOwnerUserId ||
    registry.registryRevision !== request.expectedRegistryRevision
  ) {
    throw recoveryRequired();
  }
}

function requireTerminalDeletionTruth(
  input: {
    coreDb: CoreDb;
    store: FsStore;
    workspaceId: string;
    recovery?: RecoveryAdmission;
  },
  request: WorkspaceDeletionRequestRecord
): { auditEventId: string; commandReceiptKey: string } {
  const registry = getWorkspaceRegistryLifecycleFact(input.coreDb, input.workspaceId);
  const auditEvents = listServerAuditEvents(input.coreDb).filter(
    (event) =>
      event.action === 'workspace.delete' &&
      event.requestId === request.requestId &&
      event.workspaceId === input.workspaceId &&
      event.outcome === 'succeeded'
  );
  const terminalAudit = auditEvents[0];
  if (auditEvents.length !== 1 || terminalAudit?.actor?.kind !== 'user') throw recoveryRequired();
  const scope = {
    ...CORE_RECEIPT_OWNER,
    actorId: terminalAudit.actor.id,
    targetWorkspaceId: input.workspaceId,
  };
  const receipt = input.store.getCommandRequest(
    'workspace.delete',
    request.requestId,
    scope,
    input.coreDb
  );
  if (
    !registry ||
    !(
      registry.status === 'deleted' ||
      (registry.status === 'active' &&
        input.recovery?.state === 'finished' &&
        input.recovery.backup_id === request.recoveryBackupId &&
        input.recovery.proof.capture.manifestDigest === request.recoveryBackupManifestDigest &&
        input.recovery.proof.result.currentRevision === request.expectedRegistryRevision + 3)
    ) ||
    registry.ownerUserId !== request.originalOwnerUserId ||
    (registry.status === 'deleted'
      ? registry.registryRevision !== request.expectedRegistryRevision + 2
      : registry.registryRevision < request.expectedRegistryRevision + 3) ||
    !receipt ||
    receipt.inputHash !==
      commandInputHash({
        confirmation: request.confirmation,
        expectedRegistryRevision: request.expectedRegistryRevision,
        requestId: request.requestId,
      }) ||
    receipt.response.kind !== 'workspace_deletion' ||
    receipt.response.id !== request.requestId ||
    auditEvents.length !== 1 ||
    auditEvents[0]?.resourceRevision !== request.expectedRegistryRevision + 2 ||
    (request.commandReceiptKey !== null && request.commandReceiptKey !== receipt.key) ||
    (request.terminalAuditEventId !== null && request.terminalAuditEventId !== auditEvents[0]?.id)
  ) {
    throw recoveryRequired();
  }
  return { auditEventId: auditEvents[0].id, commandReceiptKey: receipt.key };
}

function deletionClosureId(requestId: string): string {
  return `wsclose_delete_${requestId}`;
}

function requireRequestOwnedStagingPath(request: WorkspaceDeletionRequestRecord): string {
  const expected = workspaceDeletionStagingRelativePath(request.workspaceId, request.requestId);
  if (request.stagingRelativePath !== expected) {
    throw recoveryRequired();
  }
  return expected;
}

function requireExactStagedWorkspace(
  dataRoot: string,
  request: WorkspaceDeletionRequestRecord
): string {
  const stagingRoot = join(dataRoot, requireRequestOwnedStagingPath(request));
  if (lstatSync(join(dataRoot, 'workspaces', request.workspaceId), { throwIfNoEntry: false })) {
    throw recoveryRequired();
  }
  requireWorkspaceRootIdentity(stagingRoot, request.workspaceId);
  return stagingRoot;
}

function requireTerminalWorkspaceStorage(
  dataRoot: string,
  request: WorkspaceDeletionRequestRecord
): string {
  const stagingRoot = join(dataRoot, requireRequestOwnedStagingPath(request));
  if (lstatSync(join(dataRoot, 'workspaces', request.workspaceId), { throwIfNoEntry: false })) {
    throw recoveryRequired();
  }
  const stagingStat = lstatSync(stagingRoot, { throwIfNoEntry: false });
  if (request.phase === 'cleaned') {
    if (stagingStat) {
      throw recoveryRequired();
    }
  } else if (stagingStat) {
    requireWorkspaceRootIdentity(stagingRoot, request.workspaceId);
  }
  return stagingRoot;
}

function requireWorkspaceRootIdentity(root: string, workspaceId: string): void {
  assertCanonicalDirectory(root);
  assertCanonicalDirectory(join(root, 'db'));
  const path = join(root, 'db', 'workspace.sqlite');
  assertCanonicalRegularFile(path);
  const workspace = readNativeProduct(
    {
      path,
      owner: { kind: 'workspace', workspaceId },
    },
    'workspace',
    workspaceId
  );
  if (!workspace) throw recoveryRequired();
  const record = readRetainedV1(workspace.record, WorkspaceSystemRecordSchema.parse);
  if (record.id !== workspaceId) {
    throw recoveryRequired();
  }
}

function removeSupersededWorkspaceExports(
  dataRoot: string,
  request: WorkspaceDeletionRequestRecord
): void {
  const root = join(dataRoot, 'server/exports/workspaces', request.workspaceId);
  if (!existsSync(root)) return;
  assertCanonicalDirectory(root);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw recoveryRequired();
    rmSync(path, { recursive: true });
  }
  fsyncDirectory(root);
}

function deletionHoldRecordIds(
  repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb,
  workspaceId: string
): string[] {
  const workspaceDb = repositoryWorkspaceDb(workspaceId);
  try {
    return listWorkspaceDeletionHoldRecordIds(workspaceDb, workspaceId);
  } finally {
    workspaceDb.sqlite.close();
  }
}

function requireDeletingRegistry(coreDb: CoreDb, request: WorkspaceDeletionRequestRecord): void {
  const registry = getWorkspaceRegistryLifecycleFact(coreDb, request.workspaceId);
  if (
    !registry ||
    registry.status !== 'deleting' ||
    registry.ownerUserId !== request.originalOwnerUserId ||
    registry.registryRevision !== request.expectedRegistryRevision + 1
  ) {
    throw recoveryRequired();
  }
}

function persistDeletionPhase(
  dataRoot: string,
  request: WorkspaceDeletionRequestRecord,
  update: Partial<WorkspaceDeletionRequestRecord>
): WorkspaceDeletionRequestRecord {
  return writeWorkspaceDeletionRequest(dataRoot, { ...request, ...update });
}

function deletionResponse(
  request: WorkspaceDeletionRequestRecord
): ReturnType<typeof WorkspaceDeletionResponseSchema.parse> {
  return WorkspaceDeletionResponseSchema.parse({ deletion: deletionState(request) });
}

function deletionState(request: WorkspaceDeletionRequestRecord): WorkspaceDeletionState {
  const status = ['requested', 'fenced', 'blocked'].includes(request.phase)
    ? 'active'
    : ['deleting', 'exported', 'closure-sealed', 'staged'].includes(request.phase)
      ? 'deleting'
      : 'deleted';
  return {
    workspaceId: request.workspaceId,
    requestId: request.requestId,
    status,
    phase: request.phase,
    recoveryBackupId: request.recoveryBackupId,
    closureId: request.closureId,
    retainedStaging: request.retainedStaging,
  } as WorkspaceDeletionState;
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { mode: 0o700, recursive: true });
  chmodSync(path, 0o700);
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function recoveryRequired(): OperationError {
  return new OperationError(
    'recovery_required',
    'Workspace deletion state requires operator recovery.',
    409
  );
}
