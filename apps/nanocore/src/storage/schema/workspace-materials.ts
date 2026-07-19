import { sql } from 'drizzle-orm';
import { check, index, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Supported Workspace Material content families. */
export type WorkspaceMaterialKind = 'markdown' | 'text';

/** Supported Workspace Material sensitivity levels. */
export type WorkspaceMaterialSensitivity = 'public' | 'internal' | 'restricted';

/** Media types derived from one Workspace Material kind. */
export type WorkspaceMaterialMediaType = 'text/markdown' | 'text/plain';

/** Durable Thread-to-Material association states. */
export type ThreadMaterialBindingState = 'bound' | 'unbound';

/** Worker-context inclusion states for one bound Material. */
export type ThreadMaterialInclusionState = 'included' | 'excluded';

/** Workspace-owned Material identities and current revision pointers. */
export const workspaceMaterials = sqliteTable(
  'workspace_materials',
  {
    /** Workspace that owns the Material. */
    workspaceId: text('workspace_id').notNull(),
    /** Stable Material id within the Workspace. */
    materialId: text('material_id').notNull(),
    /** Human-readable Material title. */
    title: text('title').notNull(),
    /** Immutable Material content family. */
    kind: text('kind').$type<WorkspaceMaterialKind>().notNull(),
    /** Current immutable revision, or null before the first save. */
    currentRevisionId: text('current_revision_id'),
    /** Immutable Material sensitivity level. */
    sensitivity: text('sensitivity').$type<WorkspaceMaterialSensitivity>().notNull(),
    /** Request that last changed the mutable Material state. */
    lastMutationRequestId: text('last_mutation_request_id').notNull(),
    /** ISO timestamp for Material creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for the latest Material mutation. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.materialId] }),
    index('workspace_materials_list_idx').on(table.workspaceId, table.createdAt, table.materialId),
    check('workspace_materials_kind_check', sql`${table.kind} IN ('markdown', 'text')`),
    check(
      'workspace_materials_sensitivity_check',
      sql`${table.sensitivity} IN ('public', 'internal', 'restricted')`
    ),
  ]
);

/** Immutable canonical revisions for Workspace-owned Materials. */
export const workspaceMaterialRevisions = sqliteTable(
  'workspace_material_revisions',
  {
    /** Workspace that owns the Material. */
    workspaceId: text('workspace_id').notNull(),
    /** Material that owns the revision. */
    materialId: text('material_id').notNull(),
    /** Stable revision id within the Material. */
    revisionId: text('revision_id').notNull(),
    /** Previous revision in the linear Material history, or null for the root. */
    parentRevisionId: text('parent_revision_id'),
    /** Media type derived from the owning Material kind. */
    mediaType: text('media_type').$type<WorkspaceMaterialMediaType>().notNull(),
    /** SHA-256 digest of the exact UTF-8 content bytes. */
    contentDigest: text('content_digest').notNull(),
    /** Exact canonical UTF-8 Material content. */
    content: text('content').notNull(),
    /** Actor that authored the revision. */
    authorId: text('author_id').notNull(),
    /** Request that created this immutable revision. */
    createdByRequestId: text('created_by_request_id').notNull(),
    /** ISO timestamp for revision creation. */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.materialId, table.revisionId] }),
    index('workspace_material_revisions_list_idx').on(
      table.workspaceId,
      table.materialId,
      table.createdAt,
      table.revisionId
    ),
    uniqueIndex('workspace_material_revisions_root_idx')
      .on(table.workspaceId, table.materialId)
      .where(sql`${table.parentRevisionId} IS NULL`),
    uniqueIndex('workspace_material_revisions_child_idx')
      .on(table.workspaceId, table.materialId, table.parentRevisionId)
      .where(sql`${table.parentRevisionId} IS NOT NULL`),
    check(
      'workspace_material_revisions_media_type_check',
      sql`${table.mediaType} IN ('text/markdown', 'text/plain')`
    ),
    check(
      'workspace_material_revisions_digest_check',
      sql`length(${table.contentDigest}) = 71 AND substr(${table.contentDigest}, 1, 7) = 'sha256:' AND substr(${table.contentDigest}, 8) NOT GLOB '*[^0-9a-f]*'`
    ),
  ]
);

/** Explicit Thread associations and next-turn queue intent for Workspace Materials. */
export const threadMaterialBindings = sqliteTable(
  'thread_material_bindings',
  {
    /** Workspace that owns the binding. */
    workspaceId: text('workspace_id').notNull(),
    /** Thread associated with the Material. */
    threadId: text('thread_id').notNull(),
    /** Material associated with the Thread. */
    materialId: text('material_id').notNull(),
    /** Whether this historical association is currently bound. */
    bindingState: text('binding_state').$type<ThreadMaterialBindingState>().notNull(),
    /** Latest stable revision queued for a future eligible worker Turn. */
    latestQueuedRevisionId: text('latest_queued_revision_id'),
    /** Whether the queued revision may enter automatic worker context. */
    inclusionState: text('inclusion_state').$type<ThreadMaterialInclusionState>().notNull(),
    /** Request that last changed this binding or its queue. */
    lastMutationRequestId: text('last_mutation_request_id').notNull(),
    /** ISO timestamp for initial binding creation. */
    createdAt: text('created_at').notNull(),
    /** ISO timestamp for the latest binding or queue mutation. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.threadId, table.materialId] }),
    uniqueIndex('thread_material_bindings_bound_thread_idx')
      .on(table.workspaceId, table.threadId)
      .where(sql`${table.bindingState} = 'bound'`),
    index('thread_material_bindings_material_queue_idx').on(
      table.workspaceId,
      table.materialId,
      table.bindingState,
      table.threadId
    ),
    check(
      'thread_material_bindings_state_check',
      sql`${table.bindingState} IN ('bound', 'unbound')`
    ),
    check(
      'thread_material_bindings_inclusion_check',
      sql`${table.inclusionState} IN ('included', 'excluded')`
    ),
    check(
      'thread_material_bindings_unbound_check',
      sql`${table.bindingState} = 'bound' OR (${table.latestQueuedRevisionId} IS NULL AND ${table.inclusionState} = 'included')`
    ),
    check(
      'thread_material_bindings_excluded_check',
      sql`${table.inclusionState} = 'included' OR (${table.bindingState} = 'bound' AND ${table.latestQueuedRevisionId} IS NOT NULL)`
    ),
  ]
);
