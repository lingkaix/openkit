import { createHash } from 'node:crypto';

import type {
  BindThreadMaterialRequest,
  BindThreadMaterialResponse,
  CreateWorkspaceMaterialRequest,
  CreateWorkspaceMaterialResponse,
  ExcludeThreadMaterialRequest,
  ExcludeThreadMaterialResponse,
  RestoreThreadMaterialRequest,
  RestoreThreadMaterialResponse,
  SaveWorkspaceMaterialRevisionRequest,
  SaveWorkspaceMaterialRevisionResponse,
  ThreadMaterialView,
  UnbindThreadMaterialRequest,
  UnbindThreadMaterialResponse,
  WorkspaceMaterialRevisionSummary,
  WorkspaceMaterialRevisionView,
  WorkspaceMaterialView,
} from '@openkit/app-api-schemas';

import type { WorkspaceDb } from './storage/db.js';

/** Closed Material failure codes owned by S16. */
type WorkspaceMaterialErrorCode =
  | 'conflict'
  | 'recovery_required'
  | 'source_digest_mismatch'
  | 'stale';

/** Material authority row with private request proof. */
type MaterialRow = WorkspaceMaterialView & { readonly lastMutationRequestId: string };

/** Immutable revision authority row with private request proof. */
type RevisionRow = WorkspaceMaterialRevisionView & { readonly createdByRequestId: string };

/** Thread binding authority row. */
type BindingRow = {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly materialId: string;
  readonly bindingState: 'bound' | 'unbound';
  readonly latestQueuedRevisionId: string | null;
  readonly inclusionState: 'included' | 'excluded';
  readonly lastMutationRequestId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** Exact bound queue candidate supplied to the S39 Context Package owner. */
export interface QueuedThreadMaterialSelection {
  /** Material identity selected from the Thread binding. */
  readonly materialId: string;
  /** Exact immutable revision identity. */
  readonly revisionId: string;
  /** Previous immutable revision, or null for the root revision. */
  readonly parentRevisionId: string | null;
  /** Media type derived from the Material kind. */
  readonly mediaType: 'text/markdown' | 'text/plain';
  /** Digest of the exact canonical UTF-8 content. */
  readonly contentDigest: string;
  /** Exact canonical UTF-8 content. */
  readonly content: string;
  /** Immutable Material sensitivity. */
  readonly sensitivity: 'public' | 'internal' | 'restricted';
  /** Whether S39 may include the queued revision automatically. */
  readonly inclusionState: 'included' | 'excluded';
  /** S39 inclusion reason for this binding-owned candidate. */
  readonly inclusionReason: 'thread_binding';
  /** Exact binding mutation proof frozen with the selected queue. */
  readonly bindingMutationRequestId: string;
}

/** Adds the accepted timestamp to one parsed command. */
type AcceptedCommand<T> = T & { readonly acceptedAt: string };

/** Adds one Material and Thread owner scope to a parsed command. */
type BindingCommand<T> = AcceptedCommand<T> & {
  readonly materialId: string;
  readonly threadId: string;
};

/** Accepted create command with authenticated scope. */
export type CreateWorkspaceMaterialInput = AcceptedCommand<CreateWorkspaceMaterialRequest> & {
  readonly actorId: string;
};

/** Accepted save command with authenticated scope. */
export type SaveWorkspaceMaterialRevisionInput =
  AcceptedCommand<SaveWorkspaceMaterialRevisionRequest> & {
    readonly actorId: string;
    readonly materialId: string;
  };

/** Accepted bind command with its composite owner identity. */
export type BindThreadMaterialInput = BindingCommand<BindThreadMaterialRequest>;

/** Accepted unbind command with its composite owner identity. */
export type UnbindThreadMaterialInput = BindingCommand<UnbindThreadMaterialRequest>;

/** Accepted exclusion command with its composite owner identity. */
export type ExcludeThreadMaterialInput = BindingCommand<ExcludeThreadMaterialRequest>;

/** Accepted restore command with its composite owner identity. */
export type RestoreThreadMaterialInput = BindingCommand<RestoreThreadMaterialRequest>;

const MATERIAL_SELECT = `SELECT
  workspace_id AS workspaceId, material_id AS materialId, title, kind,
  current_revision_id AS currentRevisionId, sensitivity,
  last_mutation_request_id AS lastMutationRequestId,
  created_at AS createdAt, updated_at AS updatedAt
FROM workspace_materials`;

const REVISION_SELECT = `SELECT
  workspace_id AS workspaceId, material_id AS materialId, revision_id AS revisionId,
  parent_revision_id AS parentRevisionId, media_type AS mediaType,
  content_digest AS contentDigest, content, author_id AS authorId,
  created_by_request_id AS createdByRequestId, created_at AS createdAt
FROM workspace_material_revisions`;

const BINDING_SELECT = `SELECT
  workspace_id AS workspaceId, thread_id AS threadId, material_id AS materialId,
  binding_state AS bindingState, latest_queued_revision_id AS latestQueuedRevisionId,
  inclusion_state AS inclusionState, last_mutation_request_id AS lastMutationRequestId,
  created_at AS createdAt, updated_at AS updatedAt
FROM thread_material_bindings`;

/** Lists raw portable Material, revision, and binding owners in stable identity order. @param workspaceDb Workspace database. @returns Private export rows retaining request proof. */
export function listExportableWorkspaceMaterialRows(workspaceDb: WorkspaceDb): {
  readonly materials: readonly MaterialRow[];
  readonly revisions: readonly RevisionRow[];
  readonly bindings: readonly BindingRow[];
} {
  return {
    materials: workspaceDb.sqlite
      .prepare(`${MATERIAL_SELECT} WHERE workspace_id = ? ORDER BY material_id`)
      .all(workspaceDb.workspaceId) as MaterialRow[],
    revisions: workspaceDb.sqlite
      .prepare(
        `${REVISION_SELECT} WHERE workspace_id = ? ORDER BY material_id, created_at, revision_id`
      )
      .all(workspaceDb.workspaceId) as RevisionRow[],
    bindings: workspaceDb.sqlite
      .prepare(`${BINDING_SELECT} WHERE workspace_id = ? ORDER BY thread_id, material_id`)
      .all(workspaceDb.workspaceId) as BindingRow[],
  };
}

/** Lists Materials in stable order. @param workspaceDb Workspace database. @returns Closed views. @throws A recovery error for an invalid pointer. */
export function listWorkspaceMaterials(workspaceDb: WorkspaceDb): WorkspaceMaterialView[] {
  const rows = workspaceDb.sqlite
    .prepare(`${MATERIAL_SELECT} WHERE workspace_id = ? ORDER BY created_at, material_id`)
    .all(workspaceDb.workspaceId) as MaterialRow[];
  rows.forEach((row) => {
    assertMaterialPointer(workspaceDb, row);
  });
  return rows.map(toMaterialView);
}

/** Reads one Material. @param workspaceDb Workspace database. @param materialId Material id. @returns Closed view. @throws A stale or recovery error for absent or invalid authority. */
export function getWorkspaceMaterial(
  workspaceDb: WorkspaceDb,
  materialId: string
): WorkspaceMaterialView {
  const row = requireMaterial(workspaceDb, materialId);
  assertMaterialPointer(workspaceDb, row);
  return toMaterialView(row);
}

/** Lists immutable revisions in stable order. @param workspaceDb Workspace database. @param materialId Material id. @returns Closed summaries. @throws A stale or recovery error for absent or invalid authority. */
export function listWorkspaceMaterialRevisions(
  workspaceDb: WorkspaceDb,
  materialId: string
): WorkspaceMaterialRevisionSummary[] {
  requireMaterial(workspaceDb, materialId);
  const rows = workspaceDb.sqlite
    .prepare(
      `${REVISION_SELECT} WHERE workspace_id = ? AND material_id = ? ORDER BY created_at, revision_id`
    )
    .all(workspaceDb.workspaceId, materialId) as RevisionRow[];
  rows.forEach(assertRevisionContent);
  return rows.map(toRevisionSummary);
}

/** Reads an exact revision. @param workspaceDb Workspace database. @param materialId Material id. @param revisionId Revision id. @returns Closed content view. @throws A stale or recovery error for absent or invalid authority. */
export function getWorkspaceMaterialRevision(
  workspaceDb: WorkspaceDb,
  materialId: string,
  revisionId: string
): WorkspaceMaterialRevisionView {
  requireMaterial(workspaceDb, materialId);
  const row = findRevision(workspaceDb, materialId, revisionId);
  if (!row) {
    throw materialError('stale', 'The requested Material revision does not exist.');
  }
  assertRevisionContent(row);
  return toRevisionView(row);
}

/** Reads a Thread's singular Material. @param workspaceDb Workspace database. @param threadId Thread id. @returns Closed projection or null. @throws A recovery error for invalid binding lineage. */
export function getThreadMaterial(
  workspaceDb: WorkspaceDb,
  threadId: string
): ThreadMaterialView | null {
  const binding = workspaceDb.sqlite
    .prepare(
      `${BINDING_SELECT} WHERE workspace_id = ? AND thread_id = ? AND binding_state = 'bound'`
    )
    .get(workspaceDb.workspaceId, threadId) as BindingRow | undefined;
  if (!binding) {
    return null;
  }
  const material = findMaterial(workspaceDb, binding.materialId);
  if (!material) {
    throw materialError('recovery_required', 'The bound Material authority is missing.');
  }
  const currentRevision = material.currentRevisionId
    ? findRevision(workspaceDb, material.materialId, material.currentRevisionId)
    : undefined;
  if (material.currentRevisionId && !currentRevision) {
    throw materialError('recovery_required', 'The bound Material current revision is missing.');
  }
  if (currentRevision) {
    assertRevisionContent(currentRevision);
  }
  assertBindingQueue(workspaceDb, binding, material);
  return {
    workspaceId: workspaceDb.workspaceId,
    threadId,
    resource: toMaterialView(material),
    currentRevision: currentRevision ? toRevisionSummary(currentRevision) : null,
    inclusionState: binding.inclusionState,
    latestQueuedRevisionId: binding.latestQueuedRevisionId,
    lastWorkerSeenRevisionId: null,
    currentTurnRevisionId: null,
    activeDelivery: null,
  };
}

/**
 * Selects the exact queued revision from one bound Thread Material.
 *
 * @param workspaceDb Workspace database.
 * @param threadId Thread whose eligible queue should be read.
 * @returns Canonical S39 candidate, or null when no bound queue exists.
 * @throws A recovery error when the queued Material authority is missing or contradictory.
 */
export function selectQueuedThreadMaterialRevision(
  workspaceDb: WorkspaceDb,
  threadId: string
): QueuedThreadMaterialSelection | null {
  const binding = workspaceDb.sqlite
    .prepare(
      `${BINDING_SELECT} WHERE workspace_id = ? AND thread_id = ? AND binding_state = 'bound'`
    )
    .get(workspaceDb.workspaceId, threadId) as BindingRow | undefined;
  if (!binding || binding.latestQueuedRevisionId === null) {
    return null;
  }
  const material = findMaterial(workspaceDb, binding.materialId);
  if (!material) {
    throw materialError('recovery_required', 'The queued Material authority is missing.');
  }
  const revision = assertBindingQueue(workspaceDb, binding, material);
  if (!revision) {
    throw materialError('recovery_required', 'The queued Material revision is missing.');
  }
  const expectedMediaType = material.kind === 'markdown' ? 'text/markdown' : 'text/plain';
  if (revision.mediaType !== expectedMediaType) {
    throw materialError('recovery_required', 'The queued Material media type is invalid.');
  }
  if (
    revision.parentRevisionId &&
    (revision.parentRevisionId === revision.revisionId ||
      !findRevision(workspaceDb, material.materialId, revision.parentRevisionId))
  ) {
    throw materialError('recovery_required', 'The queued Material parent revision is invalid.');
  }
  return {
    materialId: material.materialId,
    revisionId: revision.revisionId,
    parentRevisionId: revision.parentRevisionId,
    mediaType: revision.mediaType,
    contentDigest: revision.contentDigest,
    content: revision.content,
    sensitivity: material.sensitivity,
    inclusionState: binding.inclusionState,
    inclusionReason: 'thread_binding',
    bindingMutationRequestId: binding.lastMutationRequestId,
  };
}

/**
 * Clears one post-verification queue only when its revision and mutation proof still match.
 *
 * @param workspaceDb Workspace database.
 * @param threadId Thread that owned the verified selection.
 * @param materialId Material named by the verified selection.
 * @param revisionId Revision named by the verified selection.
 * @param bindingMutationRequestId Binding proof named by the verified selection.
 * @returns `consumed` for an exact or already-cleared queue, otherwise `superseded` for later intent.
 * @throws A recovery error when the named binding is missing or contradicts the same proof.
 */
export function consumeQueuedThreadMaterialRevision(
  workspaceDb: WorkspaceDb,
  threadId: string,
  materialId: string,
  revisionId: string,
  bindingMutationRequestId: string
): 'consumed' | 'superseded' {
  return workspaceDb.sqlite.transaction(() => {
    const consumed = workspaceDb.sqlite
      .prepare(`UPDATE thread_material_bindings
        SET latest_queued_revision_id = NULL
        WHERE workspace_id = ? AND thread_id = ? AND material_id = ?
          AND binding_state = 'bound' AND inclusion_state = 'included'
          AND latest_queued_revision_id = ? AND last_mutation_request_id = ?`)
      .run(workspaceDb.workspaceId, threadId, materialId, revisionId, bindingMutationRequestId);
    if (consumed.changes === 1) {
      return 'consumed';
    }
    const binding = findBinding(workspaceDb, threadId, materialId);
    if (!binding) {
      throw materialError('recovery_required', 'The verified Material binding is missing.');
    }
    if (binding.lastMutationRequestId !== bindingMutationRequestId) {
      return 'superseded';
    }
    if (
      binding.bindingState === 'bound' &&
      binding.inclusionState === 'included' &&
      binding.latestQueuedRevisionId === null
    ) {
      return 'consumed';
    }
    throw materialError('recovery_required', 'The verified Material binding is contradictory.');
  })();
}

/** Creates a deterministic Material. @param workspaceDb Workspace database. @param input Accepted command. @returns Reserved identity. @throws A recovery error for an existing request owner. */
export function createWorkspaceMaterial(
  workspaceDb: WorkspaceDb,
  input: CreateWorkspaceMaterialInput
): CreateWorkspaceMaterialResponse {
  const materialId = deterministicId('mat', [
    'material.create',
    input.actorId,
    workspaceDb.workspaceId,
    input.requestId,
  ]);
  return workspaceDb.sqlite.transaction(() => {
    if (findMaterial(workspaceDb, materialId)) {
      throw materialError('recovery_required', 'The request-owned Material has no receipt.');
    }
    workspaceDb.sqlite
      .prepare(`INSERT INTO workspace_materials (
        workspace_id, material_id, title, kind, current_revision_id, sensitivity,
        last_mutation_request_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
      .run(
        workspaceDb.workspaceId,
        materialId,
        input.title,
        input.kind,
        input.sensitivity,
        input.requestId,
        input.acceptedAt,
        input.acceptedAt
      );
    return { materialId };
  })();
}

/** Saves an immutable revision and coalesces bound queues. @param workspaceDb Workspace database. @param input Accepted command and base. @returns Material and revision ids. @throws An S16 digest, stale, conflict, or recovery error. */
export function saveWorkspaceMaterialRevision(
  workspaceDb: WorkspaceDb,
  input: SaveWorkspaceMaterialRevisionInput
): SaveWorkspaceMaterialRevisionResponse {
  const revisionId = deterministicId('mrev', [
    'material.save',
    input.actorId,
    workspaceDb.workspaceId,
    input.materialId,
    input.requestId,
  ]);
  return workspaceDb.sqlite.transaction(() => {
    if (findRevision(workspaceDb, input.materialId, revisionId)) {
      throw materialError('recovery_required', 'The request-owned revision has no receipt.');
    }
    if (contentDigest(input.content) !== input.contentDigest) {
      throw materialError('source_digest_mismatch', 'Material content does not match its digest.');
    }
    const material = findMaterial(workspaceDb, input.materialId);
    if (!material) {
      throw materialError('stale', 'The requested Material does not exist.');
    }
    assertMaterialPointer(workspaceDb, material);
    const bindings = workspaceDb.sqlite
      .prepare(
        `${BINDING_SELECT} WHERE workspace_id = ? AND material_id = ? AND binding_state = 'bound'`
      )
      .all(workspaceDb.workspaceId, input.materialId) as BindingRow[];
    bindings.forEach((binding) => {
      assertBindingQueue(workspaceDb, binding, material);
    });
    if (material.currentRevisionId !== input.expectedRevisionId) {
      throw materialError('conflict', 'The Material current revision does not match the request.');
    }
    workspaceDb.sqlite
      .prepare(`INSERT INTO workspace_material_revisions (
        workspace_id, material_id, revision_id, parent_revision_id, media_type,
        content_digest, content, author_id, created_by_request_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        workspaceDb.workspaceId,
        input.materialId,
        revisionId,
        input.expectedRevisionId,
        material.kind === 'markdown' ? 'text/markdown' : 'text/plain',
        input.contentDigest,
        input.content,
        input.actorId,
        input.requestId,
        input.acceptedAt
      );
    const pointer = workspaceDb.sqlite
      .prepare(`UPDATE workspace_materials
        SET current_revision_id = ?, last_mutation_request_id = ?, updated_at = ?
        WHERE workspace_id = ? AND material_id = ? AND current_revision_id IS ?`)
      .run(
        revisionId,
        input.requestId,
        input.acceptedAt,
        workspaceDb.workspaceId,
        input.materialId,
        input.expectedRevisionId
      );
    if (pointer.changes !== 1) {
      throw materialError('conflict', 'The Material current revision changed concurrently.');
    }
    workspaceDb.sqlite
      .prepare(`UPDATE thread_material_bindings
        SET latest_queued_revision_id = ?, last_mutation_request_id = ?, updated_at = ?
        WHERE workspace_id = ? AND material_id = ? AND binding_state = 'bound'`)
      .run(
        revisionId,
        input.requestId,
        input.acceptedAt,
        workspaceDb.workspaceId,
        input.materialId
      );
    return { materialId: input.materialId, revisionId };
  })();
}

/** Binds a Material under an exact precondition. @param workspaceDb Workspace database. @param input Accepted command. @returns Bound outcome. @throws A stale, conflict, or recovery error. */
export function bindThreadMaterial(
  workspaceDb: WorkspaceDb,
  input: BindThreadMaterialInput
): BindThreadMaterialResponse {
  return workspaceDb.sqlite.transaction(() => {
    const material = requireMaterial(workspaceDb, input.materialId);
    assertMaterialPointer(workspaceDb, material);
    const existing = findBinding(workspaceDb, input.threadId, input.materialId);
    assertFreshBinding(existing, input.requestId);
    if (
      (input.expectedBindingState === 'absent' && existing) ||
      (input.expectedBindingState === 'unbound' && existing?.bindingState !== 'unbound')
    ) {
      throw materialError('conflict', 'The Material binding state does not match the request.');
    }
    const bound = workspaceDb.sqlite
      .prepare(
        `${BINDING_SELECT} WHERE workspace_id = ? AND thread_id = ? AND binding_state = 'bound'`
      )
      .get(workspaceDb.workspaceId, input.threadId);
    if (bound) {
      throw materialError('conflict', 'The Thread already has a bound Material.');
    }
    if (existing) {
      workspaceDb.sqlite
        .prepare(`UPDATE thread_material_bindings SET
          binding_state = 'bound', latest_queued_revision_id = ?, inclusion_state = 'included',
          last_mutation_request_id = ?, updated_at = ?
          WHERE workspace_id = ? AND thread_id = ? AND material_id = ? AND binding_state = 'unbound'`)
        .run(
          material.currentRevisionId,
          input.requestId,
          input.acceptedAt,
          workspaceDb.workspaceId,
          input.threadId,
          input.materialId
        );
    } else {
      workspaceDb.sqlite
        .prepare(`INSERT INTO thread_material_bindings (
          workspace_id, thread_id, material_id, binding_state, latest_queued_revision_id,
          inclusion_state, last_mutation_request_id, created_at, updated_at
        ) VALUES (?, ?, ?, 'bound', ?, 'included', ?, ?, ?)`)
        .run(
          workspaceDb.workspaceId,
          input.threadId,
          input.materialId,
          material.currentRevisionId,
          input.requestId,
          input.acceptedAt,
          input.acceptedAt
        );
    }
    return { materialId: input.materialId, threadId: input.threadId, outcome: 'bound' as const };
  })();
}

/** Unbinds a Material while retaining history. @param workspaceDb Workspace database. @param input Accepted command. @returns Unbound outcome. @throws A stale, conflict, or recovery error. */
export function unbindThreadMaterial(
  workspaceDb: WorkspaceDb,
  input: UnbindThreadMaterialInput
): UnbindThreadMaterialResponse {
  return workspaceDb.sqlite.transaction(() => {
    const material = requireMaterial(workspaceDb, input.materialId);
    assertMaterialPointer(workspaceDb, material);
    const binding = findBinding(workspaceDb, input.threadId, input.materialId);
    assertFreshBinding(binding, input.requestId);
    if (binding) {
      assertBindingQueue(workspaceDb, binding, material);
    }
    if (!binding || binding.bindingState !== input.expectedBindingState) {
      throw materialError('conflict', 'The Material binding state does not match the request.');
    }
    workspaceDb.sqlite
      .prepare(`UPDATE thread_material_bindings SET
        binding_state = 'unbound', latest_queued_revision_id = NULL, inclusion_state = 'included',
        last_mutation_request_id = ?, updated_at = ?
        WHERE workspace_id = ? AND thread_id = ? AND material_id = ? AND binding_state = 'bound'`)
      .run(
        input.requestId,
        input.acceptedAt,
        workspaceDb.workspaceId,
        input.threadId,
        input.materialId
      );
    return { materialId: input.materialId, threadId: input.threadId, outcome: 'unbound' as const };
  })();
}

/** Excludes an exact queued revision. @param workspaceDb Workspace database. @param input Accepted command. @returns Excluded outcome. @throws A stale, conflict, or recovery error. */
export function excludeThreadMaterial(
  workspaceDb: WorkspaceDb,
  input: ExcludeThreadMaterialInput
): ExcludeThreadMaterialResponse {
  return workspaceDb.sqlite.transaction(() => {
    const material = requireMaterial(workspaceDb, input.materialId);
    assertMaterialPointer(workspaceDb, material);
    const binding = findBinding(workspaceDb, input.threadId, input.materialId);
    assertFreshBinding(binding, input.requestId);
    if (binding) {
      assertBindingQueue(workspaceDb, binding, material);
    }
    if (
      !binding ||
      binding.bindingState !== input.expectedBindingState ||
      binding.inclusionState !== input.expectedInclusionState ||
      binding.latestQueuedRevisionId !== input.expectedQueuedRevisionId
    ) {
      throw materialError('conflict', 'The queued Material binding does not match the request.');
    }
    workspaceDb.sqlite
      .prepare(`UPDATE thread_material_bindings SET
        inclusion_state = 'excluded', last_mutation_request_id = ?, updated_at = ?
        WHERE workspace_id = ? AND thread_id = ? AND material_id = ?
          AND binding_state = 'bound' AND inclusion_state = 'included'
          AND latest_queued_revision_id = ?`)
      .run(
        input.requestId,
        input.acceptedAt,
        workspaceDb.workspaceId,
        input.threadId,
        input.materialId,
        input.expectedQueuedRevisionId
      );
    return { materialId: input.materialId, threadId: input.threadId, outcome: 'excluded' as const };
  })();
}

/** Restores an excluded queue. @param workspaceDb Workspace database. @param input Accepted command. @returns Included outcome. @throws A stale, conflict, or recovery error. */
export function restoreThreadMaterial(
  workspaceDb: WorkspaceDb,
  input: RestoreThreadMaterialInput
): RestoreThreadMaterialResponse {
  return workspaceDb.sqlite.transaction(() => {
    const material = requireMaterial(workspaceDb, input.materialId);
    assertMaterialPointer(workspaceDb, material);
    const binding = findBinding(workspaceDb, input.threadId, input.materialId);
    assertFreshBinding(binding, input.requestId);
    if (binding) {
      assertBindingQueue(workspaceDb, binding, material);
    }
    if (
      !binding ||
      binding.bindingState !== input.expectedBindingState ||
      binding.inclusionState !== input.expectedInclusionState
    ) {
      throw materialError('conflict', 'The Material inclusion state does not match the request.');
    }
    workspaceDb.sqlite
      .prepare(`UPDATE thread_material_bindings SET
        inclusion_state = 'included', last_mutation_request_id = ?, updated_at = ?
        WHERE workspace_id = ? AND thread_id = ? AND material_id = ?
          AND binding_state = 'bound' AND inclusion_state = 'excluded'`)
      .run(
        input.requestId,
        input.acceptedAt,
        workspaceDb.workspaceId,
        input.threadId,
        input.materialId
      );
    return { materialId: input.materialId, threadId: input.threadId, outcome: 'included' as const };
  })();
}

/** Finds one Material row. @param db Workspace database. @param id Material id. @returns Row or undefined. */
function findMaterial(db: WorkspaceDb, id: string): MaterialRow | undefined {
  return db.sqlite
    .prepare(`${MATERIAL_SELECT} WHERE workspace_id = ? AND material_id = ?`)
    .get(db.workspaceId, id) as MaterialRow | undefined;
}

/** Requires one Material row. @param db Workspace database. @param id Material id. @returns Row. @throws A stale error when absent. */
function requireMaterial(db: WorkspaceDb, id: string): MaterialRow {
  const row = findMaterial(db, id);
  if (!row) {
    throw materialError('stale', 'The requested Material does not exist.');
  }
  return row;
}

/** Finds one revision row. @param db Workspace database. @param materialId Material id. @param revisionId Revision id. @returns Row or undefined. */
function findRevision(
  db: WorkspaceDb,
  materialId: string,
  revisionId: string
): RevisionRow | undefined {
  return db.sqlite
    .prepare(`${REVISION_SELECT} WHERE workspace_id = ? AND material_id = ? AND revision_id = ?`)
    .get(db.workspaceId, materialId, revisionId) as RevisionRow | undefined;
}

/** Finds one binding row. @param db Workspace database. @param threadId Thread id. @param materialId Material id. @returns Row or undefined. */
function findBinding(
  db: WorkspaceDb,
  threadId: string,
  materialId: string
): BindingRow | undefined {
  return db.sqlite
    .prepare(`${BINDING_SELECT} WHERE workspace_id = ? AND thread_id = ? AND material_id = ?`)
    .get(db.workspaceId, threadId, materialId) as BindingRow | undefined;
}

/** Rejects request-owned binding state without a receipt. @param row Existing binding. @param requestId Request id. @throws A recovery error for matching proof. */
function assertFreshBinding(row: BindingRow | undefined, requestId: string): void {
  if (row?.lastMutationRequestId === requestId) {
    throw materialError('recovery_required', 'The request-owned binding has no receipt.');
  }
}

/** Verifies a Material pointer. @param db Workspace database. @param row Material row. @throws A recovery error for invalid authority. */
function assertMaterialPointer(db: WorkspaceDb, row: MaterialRow): void {
  if (!row.currentRevisionId) {
    return;
  }
  const revision = findRevision(db, row.materialId, row.currentRevisionId);
  if (!revision) {
    throw materialError('recovery_required', 'The Material current revision is missing.');
  }
  assertRevisionContent(revision);
}

/** Verifies a queued revision. @param db Workspace database. @param row Binding row. @param material Owning Material. @returns Verified revision or undefined for an empty queue. @throws A recovery error for invalid authority. */
function assertBindingQueue(
  db: WorkspaceDb,
  row: BindingRow,
  material: MaterialRow
): RevisionRow | undefined {
  if (!row.latestQueuedRevisionId) {
    return undefined;
  }
  if (row.latestQueuedRevisionId !== material.currentRevisionId) {
    throw materialError('recovery_required', 'The bound Material queue is not current.');
  }
  const revision = findRevision(db, row.materialId, row.latestQueuedRevisionId);
  if (!revision) {
    throw materialError('recovery_required', 'The bound Material queue revision is missing.');
  }
  assertRevisionContent(revision);
  return revision;
}

/** Verifies stored revision bytes. @param row Revision row. @throws A recovery error for a digest mismatch. */
function assertRevisionContent(row: RevisionRow): void {
  if (contentDigest(row.content) !== row.contentDigest) {
    throw materialError('recovery_required', 'The stored Material revision digest is invalid.');
  }
}

/** Projects a closed Material view. @param row Authority row. @returns Public view. */
function toMaterialView(row: MaterialRow): WorkspaceMaterialView {
  return {
    workspaceId: row.workspaceId,
    materialId: row.materialId,
    title: row.title,
    kind: row.kind,
    currentRevisionId: row.currentRevisionId,
    sensitivity: row.sensitivity,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Projects a closed revision summary. @param row Authority row. @returns Public summary. */
function toRevisionSummary(row: RevisionRow): WorkspaceMaterialRevisionSummary {
  return {
    workspaceId: row.workspaceId,
    materialId: row.materialId,
    revisionId: row.revisionId,
    parentRevisionId: row.parentRevisionId,
    mediaType: row.mediaType,
    contentDigest: row.contentDigest,
    authorId: row.authorId,
    createdAt: row.createdAt,
  };
}

/** Projects a closed exact revision. @param row Authority row. @returns Public view. */
function toRevisionView(row: RevisionRow): WorkspaceMaterialRevisionView {
  return { ...toRevisionSummary(row), content: row.content };
}

/** Computes the exact UTF-8 digest. @param content Canonical content. @returns SHA-256 digest. */
function contentDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** Derives a stable local owner id. @param prefix Identity prefix. @param scope Immutable scope. @returns Stable id. */
function deterministicId(prefix: 'mat' | 'mrev', scope: readonly string[]): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(scope)).digest('hex').slice(0, 24)}`;
}

/** Creates one structural S16 error. @param code Stable code. @param message Failure summary. @returns Typed error. */
function materialError(
  code: WorkspaceMaterialErrorCode,
  message: string
): Error & { readonly code: WorkspaceMaterialErrorCode; readonly status: 400 | 409 } {
  return Object.assign(new Error(message), {
    code,
    status: code === 'source_digest_mismatch' ? (400 as const) : (409 as const),
  });
}
