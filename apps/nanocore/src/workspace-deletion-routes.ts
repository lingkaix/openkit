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

import {
  DeleteWorkspaceRequestSchema,
  RecoverDeletedWorkspaceRequestSchema,
  RecoverDeletedWorkspaceResponseSchema,
  WorkspaceDeletionResponseSchema,
  type WorkspaceDeletionState,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import { apiErrorPayload, asApiError, asInvalidRequestError } from './api-errors.js';
import { listServerAuditEvents, recordServerAuditEvent } from './audit-events.js';
import type { AuthVariables } from './auth/middleware.js';
import { isCanonicalUserActive } from './auth/user-lifecycle.js';
import type { FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import { commandInputHash } from './runtime/idempotent-command.js';
import { listWorkerBackendSessions } from './runtime/worker-backend-sessions.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { verifyWorkspaceExportTree } from './storage/workspace-export.js';
import {
  assertCanonicalDirectory,
  readCanonicalTextFile,
  WorkspaceSystemRecordSchema,
} from './storage/workspace-file-records.js';
import {
  createVerifiedWorkspaceExport,
  existingWorkspaceExportRoot,
  importVerifiedWorkspace,
} from './storage/workspace-transfer-routes.js';
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
import type { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';
import {
  beginWorkspaceDeletion,
  completeWorkspaceDeletion,
  getWorkspaceRegistryLifecycleFact,
} from './workspace-sharing.js';

const CORE_RECEIPT_OWNER = { coreId: 'server' } as const;

/** Registers owner deletion and tombstone-authorized recovery routes. */
export function registerWorkspaceDeletionRoutes(input: {
  app: Hono<{ Variables: AuthVariables }>;
  closeWorkspaceMcpSessions: (workspaceId: string) => Promise<void>;
  coreDb: CoreDb | undefined;
  dataRoot: string | null;
  mutationAdmission: WorkspaceMutationAdmission;
  repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  registerAppApiRoute(input.app, 'deleteWorkspace', async (context) => {
    const parsed = DeleteWorkspaceRequestSchema.safeParse(
      await context.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }
    const coreDb = input.coreDb;
    const dataRoot = input.dataRoot;
    if (!coreDb || !dataRoot) {
      return asApiError(
        'Workspace deletion is unavailable.',
        'workspace_deletion_unavailable',
        503
      );
    }
    const workspaceId = context.req.param('workspaceId');
    if (
      parsed.data.confirmation !==
      `permanently-delete-workspace:${workspaceId}:${parsed.data.expectedRegistryRevision}`
    ) {
      return asApiError(
        'Workspace deletion confirmation does not match the request path.',
        'invalid_request',
        400
      );
    }
    const actor = context.get('actor');
    if (!actor || (actor.kind !== 'local' && actor.kind !== 'session' && actor.kind !== 'token')) {
      return workspaceDeletionError('workspace_access_denied', 'Workspace access denied.', 403);
    }

    try {
      return await input.mutationAdmission.runDeletionExclusive(workspaceId, async () => {
        const result = await advanceWorkspaceDeletion({
          actorId: actor.userId,
          closeWorkspaceMcpSessions: input.closeWorkspaceMcpSessions,
          coreDb,
          dataRoot,
          mutationAdmission: input.mutationAdmission,
          repositoryWorkspaceDb: input.repositoryWorkspaceDb,
          request: parsed.data,
          store: input.requestStore(context),
          workspaceId,
        });
        return context.json(result.body, result.status);
      });
    } catch (error) {
      if (error instanceof WorkspaceDeletionRouteError) {
        return workspaceDeletionError(error.code, error.message, error.status, error.details);
      }
      return workspaceDeletionError(
        'recovery_required',
        'Workspace deletion state requires operator recovery.',
        409
      );
    }
  });

  registerAppApiRoute(input.app, 'recoverDeletedWorkspace', async (context) => {
    const parsed = RecoverDeletedWorkspaceRequestSchema.safeParse(
      await context.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }
    const coreDb = input.coreDb;
    const dataRoot = input.dataRoot;
    if (!coreDb || !dataRoot) {
      return asApiError(
        'Deleted Workspace recovery is unavailable.',
        'workspace_recovery_unavailable',
        503
      );
    }
    const actor = context.get('actor');
    const workspaceId = context.req.param('workspaceId');
    if (!actor || (actor.kind !== 'local' && actor.kind !== 'session')) {
      return workspaceDeletionError('workspace_access_denied', 'Workspace access denied.', 403);
    }
    try {
      const registry = getWorkspaceRegistryLifecycleFact(coreDb, workspaceId);
      if (
        !registry ||
        registry.status !== 'deleted' ||
        registry.ownerUserId !== actor.userId ||
        !isCanonicalUserActive(coreDb, actor.userId)
      ) {
        return workspaceDeletionError('workspace_access_denied', 'Workspace access denied.', 403);
      }
      const request = readWorkspaceDeletionRequest(
        dataRoot,
        workspaceId,
        parsed.data.deletionRequestId
      );
      if (
        !['deleted', 'cleaned'].includes(request.phase) ||
        !request.recoveryExportId ||
        !request.recoveryExportManifestDigest ||
        !request.closureId ||
        !request.closureDigest
      ) {
        throw new Error('Workspace deletion request is not recoverable.');
      }
      requireTerminalWorkspaceStorage(dataRoot, request);
      requireTerminalDeletionTruth(
        { coreDb, store: input.requestStore(context), workspaceId },
        request
      );
      const verified = verifyDeletionArtifacts(dataRoot, request);
      const imported = importVerifiedWorkspace({
        authorityUserId: actor.userId,
        coreDb,
        dataRoot,
        requestId: parsed.data.requestId,
        store: input.requestStore(context),
        verified,
      });
      return context.json(
        RecoverDeletedWorkspaceResponseSchema.parse({
          recovery: {
            sourceWorkspaceId: workspaceId,
            deletionRequestId: request.requestId,
            recoveryExportId: request.recoveryExportId,
            closureId: request.closureId,
            import: imported,
          },
        })
      );
    } catch {
      return workspaceDeletionError(
        'recovery_required',
        'Deleted Workspace recovery requires operator inspection.',
        409
      );
    }
  });
}

async function advanceWorkspaceDeletion(input: {
  actorId: string;
  closeWorkspaceMcpSessions: (workspaceId: string) => Promise<void>;
  coreDb: CoreDb;
  dataRoot: string;
  mutationAdmission: WorkspaceMutationAdmission;
  repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  request: { confirmation: string; expectedRegistryRevision: number; requestId: string };
  store: FsStore;
  workspaceId: string;
}): Promise<{ body: ReturnType<typeof WorkspaceDeletionResponseSchema.parse>; status: 200 | 202 }> {
  let request = selectDeletionRequest(input);
  if (request.phase === 'blocked') {
    requireActiveBlockedRegistry(input.coreDb, request);
    return { body: deletionResponse(request), status: 200 };
  }
  if (request.phase === 'cleaned') {
    requireTerminalWorkspaceStorage(input.dataRoot, request);
    requireTerminalDeletionTruth(input, request);
    verifyDeletionArtifacts(input.dataRoot, request);
    return { body: deletionResponse(request), status: 200 };
  }
  await input.mutationAdmission.close(input.workspaceId);
  await input.closeWorkspaceMcpSessions(input.workspaceId);
  if (!isCanonicalUserActive(input.coreDb, request.originalOwnerUserId)) {
    if (['requested', 'fenced'].includes(request.phase)) {
      request = persistDeletionPhase(input.dataRoot, request, { phase: 'blocked' });
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
      input.mutationAdmission.reopen(input.workspaceId);
      throw new WorkspaceDeletionRouteError(
        'workspace_deletion_blocked',
        'Workspace deletion is blocked by legal hold.',
        409,
        { holdRecordIds }
      );
    }
  }
  if (
    request.phase === 'fenced' &&
    hasActiveWorkspaceRuntime({
      coreDb: input.coreDb,
      repositoryWorkspaceDb: input.repositoryWorkspaceDb,
      store: input.store,
      workspaceId: input.workspaceId,
    })
  ) {
    return { body: deletionResponse(request), status: 202 };
  }
  if (request.phase === 'fenced') {
    const deleting = input.coreDb.sqlite.transaction(() =>
      beginWorkspaceDeletion({
        coreDb: input.coreDb,
        workspaceId: input.workspaceId,
        originalOwnerUserId: request.originalOwnerUserId,
        expectedRegistryRevision: request.expectedRegistryRevision,
      })
    )();
    request = persistDeletionPhase(input.dataRoot, request, { phase: 'deleting' });
    if (deleting.registryRevision !== request.expectedRegistryRevision + 1) {
      throw recoveryRequired();
    }
  }
  if (['deleting', 'exported', 'closure-sealed', 'staged'].includes(request.phase)) {
    requireDeletingRegistry(input.coreDb, request);
  }
  if (request.phase === 'deleting') {
    const exportId = deletionRecoveryExportId(request.requestId);
    const exportRoot = join(
      input.dataRoot,
      'server',
      'exports',
      'workspaces',
      input.workspaceId,
      exportId
    );
    const exported = existsSync(exportRoot)
      ? verifyWorkspaceExportTree({
          exportRoot: existingWorkspaceExportRoot(input.dataRoot, input.workspaceId, exportId),
        })
      : createVerifiedWorkspaceExport({
          authorityUserId: request.originalOwnerUserId,
          coreDb: input.coreDb,
          dataRoot: input.dataRoot,
          exportId,
          repositoryWorkspaceDb: input.repositoryWorkspaceDb,
          store: input.store,
          workspaceId: input.workspaceId,
        }).verified;
    if (exported.manifest.id !== exportId || exported.manifest.workspaceId !== input.workspaceId) {
      throw recoveryRequired();
    }
    request = persistDeletionPhase(input.dataRoot, request, {
      phase: 'exported',
      recoveryExportId: exported.manifest.id,
      recoveryExportManifestDigest: exported.manifestDigest,
    });
  }
  if (request.phase === 'exported') {
    const verified = verifyRecoveryExport(input.dataRoot, request);
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
          recoveryExportId: verified.manifest.id,
          recoveryExportManifestDigest: verified.manifestDigest,
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
          recoveryExportId: verified.manifest.id,
          recoveryExportManifestDigest: verified.manifestDigest,
        });
    request = persistDeletionPhase(input.dataRoot, request, {
      phase: 'closure-sealed',
      closureId,
      closureDigest: closure.manifestDigest,
    });
  }
  if (request.phase === 'closure-sealed') {
    verifyDeletionArtifacts(input.dataRoot, request);
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
      mkdirPrivate(dirname(target));
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
    verifyDeletionArtifacts(input.dataRoot, request);
    removeSupersededWorkspaceExports(input.dataRoot, request);
    const terminal = input.coreDb.sqlite.transaction(() => {
      const registry = completeWorkspaceDeletion({
        coreDb: input.coreDb,
        workspaceId: input.workspaceId,
        originalOwnerUserId: request.originalOwnerUserId,
        expectedRegistryRevision: request.expectedRegistryRevision + 1,
      });
      const audit = recordServerAuditEvent({
        action: 'workspace.delete',
        actor: { id: request.originalOwnerUserId, kind: 'user' },
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
            actorId: request.originalOwnerUserId,
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
    verifyDeletionArtifacts(input.dataRoot, request);
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

function selectDeletionRequest(input: {
  actorId: string;
  coreDb: CoreDb;
  dataRoot: string;
  repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  request: { confirmation: string; expectedRegistryRevision: number; requestId: string };
  workspaceId: string;
}): WorkspaceDeletionRequestRecord {
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
      existing.originalOwnerUserId !== input.actorId ||
      existing.expectedRegistryRevision !== input.request.expectedRegistryRevision ||
      existing.confirmation !== input.request.confirmation
    ) {
      throw new WorkspaceDeletionRouteError(
        'idempotency_key_conflict',
        'The requestId was already used for different command input.',
        409
      );
    }
    return existing;
  }
  if (nonterminal[0]) {
    throw new WorkspaceDeletionRouteError(
      'workspace_deletion_in_progress',
      'Another deletion request already owns this Workspace.',
      409,
      deletionState(nonterminal[0])
    );
  }
  const registry = getWorkspaceRegistryLifecycleFact(input.coreDb, input.workspaceId);
  if (
    !registry ||
    registry.status !== 'active' ||
    registry.ownerUserId !== input.actorId ||
    registry.registryRevision !== input.request.expectedRegistryRevision
  ) {
    throw new WorkspaceDeletionRouteError(
      'workspace_access_denied',
      'Workspace access denied.',
      403
    );
  }
  const holdRecordIds = deletionHoldRecordIds(input.repositoryWorkspaceDb, input.workspaceId);
  if (holdRecordIds.length > 0) {
    throw new WorkspaceDeletionRouteError(
      'workspace_deletion_blocked',
      'Workspace deletion is blocked by legal hold.',
      409,
      { holdRecordIds }
    );
  }
  return createWorkspaceDeletionRequest(input.dataRoot, {
    confirmation: input.request.confirmation,
    createdAt: new Date().toISOString(),
    expectedRegistryRevision: input.request.expectedRegistryRevision,
    originalOwnerUserId: input.actorId,
    requestId: input.request.requestId,
    workspaceId: input.workspaceId,
  });
}

function verifyRecoveryExport(
  dataRoot: string,
  request: WorkspaceDeletionRequestRecord
): ReturnType<typeof verifyWorkspaceExportTree> {
  if (!request.recoveryExportId || !request.recoveryExportManifestDigest) {
    throw recoveryRequired();
  }
  const verified = verifyWorkspaceExportTree({
    exportRoot: existingWorkspaceExportRoot(
      dataRoot,
      request.workspaceId,
      request.recoveryExportId
    ),
  });
  if (
    verified.manifest.workspaceId !== request.workspaceId ||
    verified.manifest.id !== request.recoveryExportId ||
    verified.manifestDigest !== request.recoveryExportManifestDigest
  ) {
    throw recoveryRequired();
  }
  return verified;
}

function verifyDeletionArtifacts(
  dataRoot: string,
  request: WorkspaceDeletionRequestRecord
): ReturnType<typeof verifyWorkspaceExportTree> {
  const verified = verifyRecoveryExport(dataRoot, request);
  if (!request.closureId || !request.closureDigest) {
    throw recoveryRequired();
  }
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
    recoveryExportId: verified.manifest.id,
    recoveryExportManifestDigest: verified.manifestDigest,
  });
  if (closure.manifestDigest !== request.closureDigest) {
    throw recoveryRequired();
  }
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
  },
  request: WorkspaceDeletionRequestRecord
): { auditEventId: string; commandReceiptKey: string } {
  const registry = getWorkspaceRegistryLifecycleFact(input.coreDb, input.workspaceId);
  const scope = {
    ...CORE_RECEIPT_OWNER,
    actorId: request.originalOwnerUserId,
    targetWorkspaceId: input.workspaceId,
  };
  const receipt = input.store.getCommandRequest(
    'workspace.delete',
    request.requestId,
    scope,
    input.coreDb
  );
  const auditEvents = listServerAuditEvents(input.coreDb).filter(
    (event) =>
      event.action === 'workspace.delete' &&
      event.requestId === request.requestId &&
      event.workspaceId === input.workspaceId &&
      event.outcome === 'succeeded'
  );
  if (
    !registry ||
    registry.status !== 'deleted' ||
    registry.ownerUserId !== request.originalOwnerUserId ||
    registry.registryRevision !== request.expectedRegistryRevision + 2 ||
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
    auditEvents[0]?.resourceRevision !== registry.registryRevision ||
    (request.commandReceiptKey !== null && request.commandReceiptKey !== receipt.key) ||
    (request.terminalAuditEventId !== null && request.terminalAuditEventId !== auditEvents[0]?.id)
  ) {
    throw recoveryRequired();
  }
  return { auditEventId: auditEvents[0].id, commandReceiptKey: receipt.key };
}

function deletionRecoveryExportId(requestId: string): string {
  return `wsexp_delete_${requestId}`;
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
  const record = WorkspaceSystemRecordSchema.parse(
    JSON.parse(readCanonicalTextFile(join(root, 'workspace-record.json')))
  );
  if (record.id !== workspaceId) {
    throw recoveryRequired();
  }
}

function removeSupersededWorkspaceExports(
  dataRoot: string,
  request: WorkspaceDeletionRequestRecord
): void {
  if (!request.recoveryExportId) {
    throw recoveryRequired();
  }
  const workspaceExportsRoot = dirname(
    existingWorkspaceExportRoot(dataRoot, request.workspaceId, request.recoveryExportId)
  );
  for (const entry of readdirSync(workspaceExportsRoot, { withFileTypes: true })) {
    if (entry.name === request.recoveryExportId) {
      continue;
    }
    const path = join(workspaceExportsRoot, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw recoveryRequired();
    }
    rmSync(path, { recursive: true });
  }
  fsyncDirectory(workspaceExportsRoot);
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

function hasActiveWorkspaceRuntime(input: {
  coreDb: CoreDb;
  repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  store: FsStore;
  workspaceId: string;
}): boolean {
  if (
    input.store
      .listWorkspaceAgentSessions(input.workspaceId)
      .some((session) => ['created', 'initializing', 'busy'].includes(session.status)) ||
    input.coreDb.sqlite
      .prepare(
        `SELECT 1 FROM scheduler_session_leases
         WHERE workspace_id = ?
           AND (
             status NOT IN ('idle', 'released', 'lost', 'failed')
             OR recovery_state = 'needs-evidence'
           )
         LIMIT 1`
      )
      .get(input.workspaceId) ||
    listWorkerBackendSessions(input.coreDb).some(
      (session) => session.workspaceId === input.workspaceId && session.state !== 'cleaned'
    )
  ) {
    return true;
  }
  const workspaceDb = input.repositoryWorkspaceDb(input.workspaceId);
  try {
    return Boolean(
      workspaceDb.sqlite
        .prepare(
          `SELECT 1
           FROM workspace_apply_plans AS plan
           WHERE plan.workspace_id = ? AND plan.approval_state = 'approved'
             AND NOT EXISTS (
               SELECT 1 FROM workspace_apply_results AS result
               WHERE result.workspace_id = plan.workspace_id
                 AND result.review_id = plan.review_id
                 AND result.change_set_id = plan.change_set_id
             )
           LIMIT 1`
        )
        .get(input.workspaceId)
    );
  } finally {
    workspaceDb.sqlite.close();
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
    recoveryExportId: request.recoveryExportId,
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

function workspaceDeletionError(
  code: string,
  message: string,
  status: number,
  details?: unknown
): Response {
  return Response.json(
    apiErrorPayload({ code, message, ...(details === undefined ? {} : { details }) }),
    { status }
  );
}

function recoveryRequired(): WorkspaceDeletionRouteError {
  return new WorkspaceDeletionRouteError(
    'recovery_required',
    'Workspace deletion state requires operator recovery.',
    409
  );
}

class WorkspaceDeletionRouteError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message);
  }
}
