import {
  KnowledgeBaseIdSchema,
  KnowledgeContentReferenceSchema,
  readRetainedV1,
  WorkspaceIdSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import { STORAGE_LIMITS, type StorageContent } from '@openkit/storage';
import { z } from 'zod';
import type { ControlSqlStatement } from './control-store-worker-protocol.js';
import type { WorkspaceDb } from './db.js';

/** Exact selected immutable Notebook tree and original schema bytes, owned by one Workspace KB. */
export interface ControlKnowledgeHead {
  readonly workspaceId: string;
  readonly knowledgeBaseId: string;
  readonly notebookCommit: string;
  readonly schemaContent: StorageContent;
}

/** Shared whole-content codec used by the head and its Proposal records. */
export const controlKnowledgeContentSchema = z.object({
  reference: KnowledgeContentReferenceSchema,
  byteLength: z.number().int().nonnegative().max(STORAGE_LIMITS.contentBytes),
  mediaType: z.string().min(1),
});

const headSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  knowledgeBaseId: KnowledgeBaseIdSchema,
  // Notebook commit IDs are opaque retained Git identities, not content digests.
  notebookCommit: z.string().min(1),
  schemaContent: controlKnowledgeContentSchema,
  requiredFeatures: z.array(z.never()),
});

// JSON.parse selects the last duplicate key; SQLite selects the first. Refuse
// ambiguity in this owned core before either selection can authorize a transition.
// Unknown descriptive additions remain outside the core and need no new decoder.
const unambiguousHeadCore = `NOT EXISTS (
  SELECT 1 FROM json_tree(record_json)
  WHERE fullkey IN (${[
    '$.schemaVersion',
    '$.requiredFeatures',
    '$.workspaceId',
    '$.knowledgeBaseId',
    '$.notebookCommit',
    '$.schemaContent',
    '$.schemaContent.byteLength',
    '$.schemaContent.mediaType',
    '$.schemaContent.reference',
    '$.schemaContent.reference.knowledgeBaseId',
    '$.schemaContent.reference.contentDigest',
    '$.schemaContent.reference.range',
    '$.schemaContent.reference.availability',
    '$.schemaContent.reference.locator',
    '$.schemaContent.reference.locator.mount',
    '$.schemaContent.reference.locator.path',
    '$.schemaContent.reference.locator.ownerScope',
    '$.schemaContent.reference.locator.ownerScope.kind',
    '$.schemaContent.reference.locator.ownerScope.workspaceId',
  ]
    .map((path) => `'${path}'`)
    .join(', ')})
  GROUP BY fullkey HAVING count(*) > 1
)`;

/** Validates the complete whole-content tuple; parsing never grants current access or publication. */
export function decodeControlKnowledgeHead(record: unknown): ControlKnowledgeHead {
  const parsed = headSchema.parse(record);
  const { reference } = parsed.schemaContent;
  if (
    reference.knowledgeBaseId !== parsed.knowledgeBaseId ||
    reference.locator.ownerScope.kind !== 'workspace' ||
    reference.locator.ownerScope.workspaceId !== parsed.workspaceId ||
    reference.range !== null ||
    reference.availability !== 'available' ||
    !reference.locator.path.endsWith(`sha256/${reference.contentDigest.slice(7)}`)
  ) {
    throw new TypeError('Workspace Knowledge head has inconsistent immutable content.');
  }
  const { requiredFeatures: _requiredFeatures, ...head } = parsed;
  return head;
}

/**
 * Reads both selected heads from one row without consulting a Git ref or authored YAML.
 *
 * This dormant reader has no live current-selection callers. Null means no prepared
 * row, never permission to seed or reconstruct an admitted Workspace. The eventual
 * activation owner must refuse a missing head after its authority-transfer migration.
 *
 * @param db Explicit admitted physical Workspace connection; its caller owns the lifetime.
 * @param knowledgeBaseId Exact Knowledge Base in that Workspace.
 * @returns The validated tuple, or null when the dormant row is absent.
 * @throws On unsupported retained core, container mismatch or unavailable authority.
 */
export function readControlKnowledgeHead(
  db: WorkspaceDb,
  knowledgeBaseId: string
): ControlKnowledgeHead | null {
  WorkspaceIdSchema.parse(db.workspaceId);
  KnowledgeBaseIdSchema.parse(knowledgeBaseId);
  if (db.scope !== 'workspace') throw new TypeError('Knowledge head requires a Workspace owner.');
  const row = db.sqlite
    .prepare(
      `SELECT workspace_id, knowledge_base_id, record_json, ${unambiguousHeadCore} AS unambiguous
       FROM knowledge_notebook_heads WHERE knowledge_base_id = ?`
    )
    .get(knowledgeBaseId) as
    | { workspace_id: string; knowledge_base_id: string; record_json: string; unambiguous: number }
    | undefined;
  if (!row) return null;
  if (row.unambiguous !== 1) throw new TypeError('Workspace Knowledge head has ambiguous core.');
  const head = readRetainedV1(JSON.parse(row.record_json), decodeControlKnowledgeHead);
  if (
    row.workspace_id !== db.workspaceId ||
    row.knowledge_base_id !== knowledgeBaseId ||
    head.workspaceId !== db.workspaceId ||
    head.knowledgeBaseId !== knowledgeBaseId
  ) {
    throw new TypeError('Workspace Knowledge head has inconsistent ownership.');
  }
  return head;
}

/**
 * Prepares one native conditional head mutation for composition with the original command tuple.
 *
 * The admitting owner must synchronize the referenced Git objects and exact schema
 * bytes through the existing immutable publisher before submission. These statements
 * grant no Review, receipt, Audit, current access or fresh-initialization authority.
 * No live publication caller uses them until that entire Workspace closure switches.
 * The existing worker executes all supplied statements in one savepoint and replies
 * only after its covering FULL commit. There is no Main write or second transaction.
 *
 * @param next Exact prepared immutable selection.
 * @param expected Both previously selected identities, or null only for an authorized initial insert.
 * @returns Trusted statements for the existing native writer, never a new writer or commit.
 */
export function controlKnowledgeHeadStatements(
  next: ControlKnowledgeHead,
  expected: ControlKnowledgeHead | null
): readonly Extract<ControlSqlStatement, { mode: 'run' }>[] {
  const head = decodeControlKnowledgeHead({ ...next, requiredFeatures: [] });
  const record = JSON.stringify(writeRetainedV1({ ...head, requiredFeatures: [] }));
  if (expected === null) {
    return [
      {
        mode: 'run',
        sql: `INSERT INTO knowledge_notebook_heads (workspace_id, knowledge_base_id, record_json)
              VALUES (?, ?, ?)`,
        parameters: [head.workspaceId, head.knowledgeBaseId, record],
        expectChanges: 1,
      },
    ];
  }
  const prior = decodeControlKnowledgeHead({ ...expected, requiredFeatures: [] });
  if (prior.workspaceId !== head.workspaceId || prior.knowledgeBaseId !== head.knowledgeBaseId)
    throw new TypeError('Knowledge head cannot move between owners.');
  const { reference } = prior.schemaContent;
  // Compare known descriptor facts rather than serialized JSON ordering. Inert
  // additive retained fields do not change identity; required semantics still refuse.
  return [
    {
      mode: 'run',
      sql: `UPDATE knowledge_notebook_heads SET record_json = ?
            WHERE workspace_id = ? AND knowledge_base_id = ?
              AND ${unambiguousHeadCore}
              AND json_type(record_json, '$.schemaVersion') = 'integer'
              AND json_extract(record_json, '$.schemaVersion') = 1
              AND json_type(record_json, '$.requiredFeatures') = 'array'
              AND json_array_length(record_json, '$.requiredFeatures') = 0
              AND json_extract(record_json, '$.workspaceId') = ?
              AND json_extract(record_json, '$.knowledgeBaseId') = ?
              AND json_extract(record_json, '$.notebookCommit') = ?
              AND json_extract(record_json, '$.schemaContent.reference.knowledgeBaseId') = ?
              AND json_extract(record_json, '$.schemaContent.reference.contentDigest') = ?
              AND json_type(record_json, '$.schemaContent.reference.locator.ownerScope') = 'object'
              AND NOT EXISTS (
                SELECT 1 FROM json_each(record_json, '$.schemaContent.reference.locator.ownerScope')
                WHERE key NOT IN ('kind', 'workspaceId')
              )
              AND json_extract(record_json, '$.schemaContent.reference.locator.ownerScope.kind') = 'workspace'
              AND json_extract(record_json, '$.schemaContent.reference.locator.ownerScope.workspaceId') = ?
              AND json_extract(record_json, '$.schemaContent.reference.locator.mount') = ?
              AND json_extract(record_json, '$.schemaContent.reference.locator.path') = ?
              AND json_type(record_json, '$.schemaContent.reference.range') = 'null'
              AND json_extract(record_json, '$.schemaContent.reference.availability') = 'available'
              AND json_type(record_json, '$.schemaContent.byteLength') = 'integer'
              AND json_extract(record_json, '$.schemaContent.byteLength') = ?
              AND json_extract(record_json, '$.schemaContent.mediaType') = ?`,
      parameters: [
        record,
        head.workspaceId,
        head.knowledgeBaseId,
        prior.workspaceId,
        prior.knowledgeBaseId,
        prior.notebookCommit,
        prior.knowledgeBaseId,
        reference.contentDigest,
        prior.workspaceId,
        reference.locator.mount,
        reference.locator.path,
        prior.schemaContent.byteLength,
        prior.schemaContent.mediaType,
      ],
      expectChanges: 1,
    },
  ];
}
