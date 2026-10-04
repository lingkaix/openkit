import { createHash } from 'node:crypto';
import type { MATERIAL_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { projectThreadMaterialContext } from './context/worker-context-projection.js';
import { type CommandRequestRecord, type FsStore, StoreRecordNotFoundError } from './lib/store.js';
import {
  type AdmittedOperationContext,
  type FamilyImplementations,
  publicOperationActor,
} from './operation-contract.js';
import { OperationError } from './operation-error.js';
import {
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import {
  bindThreadMaterial,
  createWorkspaceMaterial,
  excludeThreadMaterial,
  getThreadMaterial,
  getWorkspaceMaterial,
  getWorkspaceMaterialRevision,
  listWorkspaceMaterialRevisions,
  listWorkspaceMaterials,
  readWorkspaceMaterialSensitivity,
  restoreThreadMaterial,
  saveWorkspaceMaterialRevision,
  unbindThreadMaterial,
} from './workspace-materials.js';

/** Stable success identities returned by Thread Material binding commands. */
type BindingOutcome = 'bound' | 'unbound' | 'excluded' | 'included';

/** Joins Material definitions to canonical records and the existing exact-replay command owner. */
export function createMaterialOperationImplementations({
  store,
  coreDb,
  inflightCommands,
  repositoryWorkspaceDb: openWorkspaceDb,
}: {
  readonly store: FsStore;
  readonly coreDb: CoreDb | undefined;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
}) {
  /** Keeps database lifetime and known Material failures private to this family. */
  async function withWorkspace<T>(
    workspaceId: string,
    owner: (db: WorkspaceDb) => T | Promise<T>
  ): Promise<T> {
    try {
      store.getWorkspace(workspaceId);
      const db = openWorkspaceDb(workspaceId);
      try {
        return await owner(db);
      } finally {
        db.sqlite.close();
      }
    } catch (error) {
      if (error instanceof OperationError) throw error;
      if (error instanceof IdempotencyKeyConflictError)
        throw new OperationError(error.code, error.message, error.status, { cause: error });
      if (error instanceof StoreRecordNotFoundError)
        throw new OperationError('not_found', error.message, 404, { cause: error });
      const candidate = error as { code?: string; message?: string } | null;
      if (
        candidate &&
        typeof candidate.message === 'string' &&
        ['source_digest_mismatch', 'conflict', 'recovery_required', 'stale'].includes(
          candidate.code ?? ''
        )
      )
        throw new OperationError(
          candidate.code!,
          candidate.message,
          candidate.code === 'source_digest_mismatch' ? 400 : 409,
          { cause: error }
        );
      throw error;
    }
  }
  /** Refuses model delivery before exact content access, digest processing or command replay. */
  function preflight(context: AdmittedOperationContext, sensitivity: string): void {
    if (context.delivery === 'model' && sensitivity === 'restricted')
      throw new OperationError(
        'sensitive_content',
        'Restricted Material content is unavailable through model delivery.',
        409
      );
  }
  /** Executes and replays binding transitions through their one existing command owner. */
  function binding<const Outcome extends BindingOutcome>(
    input: { workspaceId: string; threadId: string; materialId: string; requestId: string },
    command: 'material.bind' | 'material.unbind' | 'material.exclude' | 'material.restore',
    expected: object,
    outcome: Outcome,
    execute: (
      db: WorkspaceDb,
      acceptedAt: string
    ) => { materialId: string; threadId: string; outcome: Outcome }
  ) {
    const { workspaceId, threadId, materialId } = input;
    return withWorkspace(workspaceId, (workspaceDb) =>
      runIdempotentCommand({
        store,
        inflightCommands,
        command,
        requestId: input.requestId,
        scope: { workspaceId, threadId, materialId },
        input: expected,
        responseKind: 'thread_material_binding',
        workspaceDb,
        workspaceTransaction: true,
        execute: () => {
          requireThreadTarget(store, workspaceId, threadId);
          return execute(workspaceDb, new Date().toISOString());
        },
        replay: (record) =>
          replayMaterialBinding(
            store,
            workspaceDb,
            workspaceId,
            threadId,
            materialId,
            outcome,
            record
          ),
        responseId: (result) => result.materialId,
      })
    );
  }
  return {
    'material.list': (input) =>
      withWorkspace(input.workspaceId, async (workspaceDb) => {
        return {
          materials: listWorkspaceMaterials(workspaceDb),
        };
      }),
    'material.create': (input, context) =>
      withWorkspace(input.workspaceId, async (workspaceDb) => {
        const { workspaceId } = input;
        preflight(context, input.sensitivity);
        const response = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'material.create',
          requestId: input.requestId,
          scope: { workspaceId },
          input: {
            title: input.title,
            kind: input.kind,
            sensitivity: input.sensitivity,
          },
          responseKind: 'material',
          workspaceDb,
          workspaceTransaction: true,
          execute: () =>
            createWorkspaceMaterial(workspaceDb, {
              ...input,
              acceptedAt: new Date().toISOString(),
              actorId: publicOperationActor(context).userId,
            }),
          replay: (record) => replayMaterialCreate(workspaceDb, record),
          responseId: (result) => result.materialId,
        });

        return response;
      }),
    'material.read': (input) =>
      withWorkspace(input.workspaceId, async (workspaceDb) => {
        const { materialId } = input;
        return {
          material: getWorkspaceMaterial(workspaceDb, materialId),
        };
      }),
    'material.revision-list': (input) =>
      withWorkspace(input.workspaceId, async (workspaceDb) => {
        const { materialId } = input;
        return {
          revisions: listWorkspaceMaterialRevisions(workspaceDb, materialId),
        };
      }),
    'material.revision-save': (input, context) =>
      withWorkspace(input.workspaceId, async (workspaceDb) => {
        const { workspaceId, materialId } = input;
        if (context.delivery === 'model')
          preflight(context, readWorkspaceMaterialSensitivity(workspaceDb, materialId));
        assertVerifiedContentDigest(input.content, input.contentDigest);
        const response = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'material.save',
          requestId: input.requestId,
          scope: { workspaceId, materialId },
          input: {
            expectedRevisionId: input.expectedRevisionId,
            contentDigest: input.contentDigest,
          },
          responseKind: 'material_revision',
          workspaceDb,
          workspaceTransaction: true,
          execute: () => {
            return saveWorkspaceMaterialRevision(workspaceDb, {
              ...input,
              acceptedAt: new Date().toISOString(),
              actorId: publicOperationActor(context).userId,
              materialId,
            });
          },
          replay: (record) => replayMaterialSave(workspaceDb, materialId, record),
          responseId: (result) => result.revisionId,
        });

        return response;
      }),
    'material.revision-read': (input, context) =>
      withWorkspace(input.workspaceId, async (workspaceDb) => {
        const { materialId, revisionId } = input;
        if (context.delivery === 'model')
          preflight(context, readWorkspaceMaterialSensitivity(workspaceDb, materialId));
        return {
          revision: getWorkspaceMaterialRevision(workspaceDb, materialId, revisionId),
        };
      }),
    'material.thread-read': (input) =>
      withWorkspace(input.workspaceId, async (workspaceDb) => {
        const { threadId } = input;
        const material = getThreadMaterial(workspaceDb, threadId);
        return {
          material:
            material && coreDb
              ? {
                  ...material,
                  ...projectThreadMaterialContext({
                    coreDb,
                    store,
                    workspaceDb,
                    threadId,
                    materialId: material.resource.materialId,
                  }),
                }
              : material,
        };
      }),
    'material.bind': (input) =>
      binding(
        input,
        'material.bind',
        { expectedBindingState: input.expectedBindingState },
        'bound',
        (db, acceptedAt) => bindThreadMaterial(db, { ...input, acceptedAt })
      ),
    'material.unbind': (input) =>
      binding(
        input,
        'material.unbind',
        { expectedBindingState: input.expectedBindingState },
        'unbound',
        (db, acceptedAt) => unbindThreadMaterial(db, { ...input, acceptedAt })
      ),
    'material.exclude': (input) =>
      binding(
        input,
        'material.exclude',
        {
          expectedBindingState: input.expectedBindingState,
          expectedInclusionState: input.expectedInclusionState,
          expectedQueuedRevisionId: input.expectedQueuedRevisionId,
        },
        'excluded',
        (db, acceptedAt) => excludeThreadMaterial(db, { ...input, acceptedAt })
      ),
    'material.restore': (input) =>
      binding(
        input,
        'material.restore',
        {
          expectedBindingState: input.expectedBindingState,
          expectedInclusionState: input.expectedInclusionState,
        },
        'included',
        (db, acceptedAt) => restoreThreadMaterial(db, { ...input, acceptedAt })
      ),
  } satisfies FamilyImplementations<typeof MATERIAL_OPERATION_DEFINITIONS>;
}

/**
 * Replays one create receipt after proving its Material owner still exists.
 *
 * @param workspaceDb Open Workspace database.
 * @param record Existing command receipt.
 * @returns Stable Material identity.
 * @throws A recovery error when receipt and owner disagree.
 */
function replayMaterialCreate(workspaceDb: WorkspaceDb, record: CommandRequestRecord) {
  if (record.response.kind !== 'material') {
    throw recoveryRequired('The Material create receipt has invalid response lineage.');
  }
  try {
    getWorkspaceMaterial(workspaceDb, record.response.id);
  } catch {
    throw recoveryRequired('The Material create receipt has no matching owner.');
  }
  return { materialId: record.response.id };
}

/**
 * Replays one save receipt after proving its exact immutable revision exists.
 *
 * @param workspaceDb Open Workspace database.
 * @param materialId Material path owner.
 * @param record Existing command receipt.
 * @returns Stable revision identity.
 * @throws A recovery error when receipt and owner disagree.
 */
function replayMaterialSave(
  workspaceDb: WorkspaceDb,
  materialId: string,
  record: CommandRequestRecord
) {
  if (record.response.kind !== 'material_revision') {
    throw recoveryRequired('The Material save receipt has invalid response lineage.');
  }
  const owner = workspaceDb.sqlite
    .prepare(`SELECT created_by_request_id AS createdByRequestId
      FROM workspace_material_revisions
      WHERE workspace_id = ? AND material_id = ? AND revision_id = ?`)
    .get(workspaceDb.workspaceId, materialId, record.response.id) as
    | { readonly createdByRequestId: string }
    | undefined;
  if (owner?.createdByRequestId !== record.requestId) {
    throw recoveryRequired('The Material save receipt has no matching revision owner.');
  }
  try {
    getWorkspaceMaterialRevision(workspaceDb, materialId, record.response.id);
  } catch {
    throw recoveryRequired('The Material save receipt has no matching revision owner.');
  }
  return {
    materialId,
    revisionId: record.response.id,
  };
}

/**
 * Replays one binding receipt from its immutable path identity and retained binding owner.
 *
 * @param store Actor-scoped product store.
 * @param workspaceDb Open Workspace database.
 * @param workspaceId Authorized path Workspace.
 * @param threadId Thread path owner.
 * @param materialId Material path owner.
 * @param outcome Stable command outcome.
 * @param record Existing command receipt.
 * @returns Stable binding success identity.
 * @throws A recovery error when receipt and owner disagree.
 */
function replayMaterialBinding<const Outcome extends BindingOutcome>(
  store: FsStore,
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  materialId: string,
  outcome: Outcome,
  record: CommandRequestRecord
): { readonly materialId: string; readonly threadId: string; readonly outcome: Outcome } {
  if (record.response.kind !== 'thread_material_binding' || record.response.id !== materialId) {
    throw recoveryRequired('The Material binding receipt has invalid response lineage.');
  }
  try {
    requireThreadTarget(store, workspaceId, threadId);
  } catch {
    throw recoveryRequired('The Material binding receipt has no matching Thread owner.');
  }
  try {
    getWorkspaceMaterial(workspaceDb, materialId);
  } catch {
    throw recoveryRequired('The Material binding receipt has no matching Material owner.');
  }
  const owner = workspaceDb.sqlite
    .prepare(`SELECT 1 FROM thread_material_bindings
      WHERE workspace_id = ? AND thread_id = ? AND material_id = ?`)
    .get(workspaceDb.workspaceId, threadId, materialId);
  if (!owner) {
    throw recoveryRequired('The Material binding receipt has no matching owner.');
  }
  return { materialId, threadId, outcome };
}

/**
 * Resolves one Thread only after its path Workspace has been authorized.
 *
 * @param store Actor-scoped product store.
 * @param workspaceId Authorized path Workspace.
 * @param threadId Requested Thread identifier.
 * @throws A stale error when the Thread is absent from the authorized Workspace.
 */
function requireThreadTarget(store: FsStore, workspaceId: string, threadId: string): void {
  try {
    store.getThread(workspaceId, threadId);
  } catch {
    throw Object.assign(new Error('The requested Thread does not exist.'), {
      code: 'stale' as const,
      status: 409 as const,
    });
  }
}

/**
 * Verifies exact Material bytes before a receipt can short-circuit command execution.
 *
 * @param content Submitted canonical content.
 * @param expectedDigest Submitted lowercase SHA-256 digest.
 * @throws A source-digest error when the bytes do not match.
 */
function assertVerifiedContentDigest(content: string, expectedDigest: string): void {
  const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  if (digest !== expectedDigest) {
    throw Object.assign(new Error('Material content does not match its digest.'), {
      code: 'source_digest_mismatch' as const,
      status: 400 as const,
    });
  }
}

/**
 * Creates the bounded S16 recovery error used by receipt-owner guards.
 *
 * @param message Product-safe recovery summary.
 * @returns Structural recovery error.
 */
function recoveryRequired(
  message: string
): Error & { readonly code: 'recovery_required'; readonly status: 409 } {
  return Object.assign(new Error(message), {
    code: 'recovery_required' as const,
    status: 409 as const,
  });
}
