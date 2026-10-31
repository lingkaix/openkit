import {
  KnowledgeBaseIdSchema,
  KnowledgeContentReferenceSchema,
  readRetainedV1,
  WorkspaceIdSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import { STORAGE_LIMITS, type StorageContent } from '@openkit/storage';
import { z } from 'zod';
import type { KnowledgeNotebook } from '../knowledge/notebook.js';
import { parseScopeKnowledgeSchema } from '../knowledge/okf.js';
import type { ControlSqlStatement } from './control-store-worker-protocol.js';
import type { WorkspaceDb } from './db.js';
import { type ImmutableContentHandoff, publishImmutableContent } from './immutable-content.js';

/** Exact selected immutable Notebook tree and original schema bytes, owned by one Workspace KB. */
export interface ControlKnowledgeHead {
  readonly workspaceId: string;
  readonly knowledgeBaseId: string;
  readonly notebookCommit: string;
  readonly schemaContent: StorageContent;
}

const headSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  knowledgeBaseId: KnowledgeBaseIdSchema,
  // Notebook commit IDs are opaque retained Git identities, not content digests.
  notebookCommit: z.string().min(1),
  schemaContent: z.object({
    reference: KnowledgeContentReferenceSchema,
    byteLength: z.number().int().nonnegative().max(STORAGE_LIMITS.contentBytes),
    mediaType: z.string().min(1),
  }),
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
function decodeHead(record: unknown): ControlKnowledgeHead {
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
 * Verifies an admitted schema stage and publishes its exact original bytes before later head SQL.
 *
 * The caller owns current admission, the existing bounded input/stage lifetime and
 * the actual private Notebook binding. Fresh Git writes use the Notebook's existing
 * fsync policy; this inspection is not a synchronization proof for historical carry.
 * No SQL transaction may span preparation. The returned facts grant no Review,
 * receipt, access, current-head selection or authority-transfer permission.
 *
 * @param input Explicit Workspace/KB, original admitted text and its sealed Storage handoff.
 * @returns Exact immutable facts for a later complete native conditional transaction.
 * @throws Before publication on an invalid schema, identity, text/stage mismatch or unavailable commit.
 */
export async function prepareControlKnowledgeHead(input: {
  readonly db: WorkspaceDb;
  readonly knowledgeBaseId: string;
  readonly notebook: KnowledgeNotebook;
  readonly notebookCommit: string;
  readonly schemaText: string;
  readonly content: ImmutableContentHandoff;
}): Promise<ControlKnowledgeHead> {
  const { db, knowledgeBaseId, notebook, notebookCommit, schemaText } = input;
  WorkspaceIdSchema.parse(db.workspaceId);
  KnowledgeBaseIdSchema.parse(knowledgeBaseId);
  if (db.scope !== 'workspace' || !db.sqlite.open || db.sqlite.inTransaction)
    throw new TypeError('Knowledge preparation requires an open Workspace outside SQL.');
  const schemaContent = headSchema.shape.schemaContent.parse(input.content.stage.content);
  const { reference } = schemaContent;
  // Capture sealed byte facts before awaits, while retaining the request's live
  // Storage admission object so an observed revocation is not frozen away.
  const handoff: ImmutableContentHandoff = {
    storage: input.content.storage,
    mountRoot: input.content.mountRoot,
    access: input.content.access,
    stage: { handle: input.content.stage.handle, content: schemaContent },
  };
  if (
    reference.knowledgeBaseId !== knowledgeBaseId ||
    reference.locator.ownerScope.kind !== 'workspace' ||
    reference.locator.ownerScope.workspaceId !== db.workspaceId ||
    reference.range !== null ||
    reference.availability !== 'available' ||
    handoff.access.knowledgeBaseId !== knowledgeBaseId ||
    handoff.access.ownerScope.kind !== 'workspace' ||
    handoff.access.ownerScope.workspaceId !== db.workspaceId ||
    handoff.access.mode !== 'staged-write' ||
    handoff.access.mount !== reference.locator.mount ||
    Buffer.from(schemaText, 'utf8').toString('utf8') !== schemaText ||
    Buffer.byteLength(schemaText, 'utf8') !== schemaContent.byteLength ||
    `sha256:${sha256Hex(schemaText)}` !== reference.contentDigest ||
    !parseScopeKnowledgeSchema(schemaText).ok
  ) {
    throw new TypeError('Knowledge schema preparation has inconsistent admitted input.');
  }
  await notebook.inspectRevisionAsync(notebookCommit);
  // The existing publisher rechecks the real sealed bytes and digest, then fsyncs
  // the create-only object and its directory. It never receives re-encoded YAML.
  const published = await publishImmutableContent(handoff);
  return decodeHead({
    workspaceId: db.workspaceId,
    knowledgeBaseId,
    notebookCommit,
    schemaContent: published,
    requiredFeatures: [],
  });
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
  const head = readRetainedV1(JSON.parse(row.record_json), decodeHead);
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
): readonly ControlSqlStatement[] {
  const head = decodeHead({ ...next, requiredFeatures: [] });
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
  const prior = decodeHead({ ...expected, requiredFeatures: [] });
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
