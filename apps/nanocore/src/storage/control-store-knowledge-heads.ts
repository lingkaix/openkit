import { isDeepStrictEqual } from 'node:util';
import { KnowledgeProposalPageIdSchema } from '@openkit/app-api-schemas';
import {
  KnowledgeBaseIdSchema,
  KnowledgeContentReferenceSchema,
  readRetainedV1,
  WorkspaceIdSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import { STORAGE_LIMITS, type StorageContent } from '@openkit/storage';
import { z } from 'zod';
import type { KnowledgeProposalReviewRecord } from '../lib/store.js';
import type { ControlSqlStatement } from './control-store-worker-protocol.js';
import type { WorkspaceDb } from './db.js';
import { KnowledgeProposalReviewFileSchema } from './knowledge-proposal-codecs.js';

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

const requiredKnowledgeFeaturesSchema = z.array(z.never());

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
  db: Pick<WorkspaceDb, 'scope' | 'sqlite' | 'workspaceId'>,
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
      sql: `UPDATE knowledge_notebook_heads SET record_json = json_set(record_json, '$.notebookCommit', ?, '$.schemaContent', json(?))
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
        head.notebookCommit,
        JSON.stringify(head.schemaContent),
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

/** Compact immutable Proposal selection; exact document bytes retain producer and Source evidence. */
export interface ControlKnowledgeProposal {
  readonly workspaceId: string;
  readonly knowledgeBaseId: string;
  readonly proposalId: string;
  readonly baseRevision: string;
  readonly candidateRevision: string;
  readonly contentDigest: string;
  readonly documentContent: StorageContent;
  readonly target:
    | { readonly knowledgePageId: string }
    | { readonly changedPageIds: readonly string[] };
}

const proposalSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  knowledgeBaseId: KnowledgeBaseIdSchema,
  proposalId: z.string().regex(/^kp_[a-f0-9]{64}$/),
  baseRevision: z.string().min(1),
  candidateRevision: z.string().min(1),
  contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  documentContent: controlKnowledgeContentSchema,
  target: z
    .object({
      knowledgePageId: KnowledgeProposalPageIdSchema.optional(),
      changedPageIds: z.array(z.string().min(1)).min(1).max(256).optional(),
    })
    .refine(
      (target) => (target.knowledgePageId !== undefined) !== (target.changedPageIds !== undefined),
      'Knowledge Proposal must identify one complete candidate.'
    )
    .transform((target) =>
      target.knowledgePageId !== undefined
        ? { knowledgePageId: target.knowledgePageId }
        : { changedPageIds: target.changedPageIds! }
    ),
  requiredFeatures: requiredKnowledgeFeaturesSchema,
});

/** One physical immutable Proposal and its existing ordered Review metadata. */
export interface ControlKnowledgeProposalState {
  readonly proposal: ControlKnowledgeProposal;
  readonly reviews: readonly KnowledgeProposalReviewRecord[];
}

/** Exact observed bytes stay inside this owner and are used only for conditional append. */
interface ProposalRow {
  readonly workspace_id: string;
  readonly knowledge_base_id: string;
  readonly proposal_id: string;
  readonly record_json: string;
  readonly reviews_json: string;
}

/** Validates compact facts without reconstructing a Proposal or replacing its immutable document. */
export function decodeProposal(record: unknown): ControlKnowledgeProposal {
  const { requiredFeatures: _requiredFeatures, ...proposal } = proposalSchema.parse(record);
  const { reference } = proposal.documentContent;
  if (
    reference.knowledgeBaseId !== proposal.knowledgeBaseId ||
    reference.locator.ownerScope.kind !== 'workspace' ||
    reference.locator.ownerScope.workspaceId !== proposal.workspaceId ||
    reference.range !== null ||
    reference.availability !== 'available' ||
    !reference.locator.path.endsWith(`sha256/${reference.contentDigest.slice(7)}`)
  )
    throw new TypeError('Knowledge Proposal has inconsistent immutable content.');
  return proposal;
}

/** Uses the existing Review lifecycle and then binds every decision to this exact immutable candidate. */
export function validateProposalReviews(
  proposal: ControlKnowledgeProposal,
  decisions: readonly unknown[]
): KnowledgeProposalReviewRecord[] {
  if (decisions.length === 0) return [];
  const { decisions: reviews } = KnowledgeProposalReviewFileSchema.parse({
    workspaceId: proposal.workspaceId,
    proposalId: proposal.proposalId,
    decisions,
  });
  for (const review of reviews) {
    const targetMatches =
      'knowledgePageId' in proposal.target
        ? review.knowledgePageId === proposal.target.knowledgePageId &&
          review.changedPageIds === undefined
        : review.knowledgePageId === undefined &&
          JSON.stringify(review.changedPageIds) === JSON.stringify(proposal.target.changedPageIds);
    if (
      review.ownerScope.kind !== 'workspace' ||
      review.ownerScope.workspaceId !== proposal.workspaceId ||
      review.baseRevision !== proposal.baseRevision ||
      review.candidateRevision !== proposal.candidateRevision ||
      review.contentDigest !== proposal.contentDigest ||
      review.proposalDigest !== proposal.documentContent.reference.contentDigest ||
      !targetMatches
    )
      throw new TypeError('Knowledge Review does not match its immutable Proposal.');
  }
  return reviews;
}

/** Reads one whole row; no SQLite JSON selection interprets authority differently from its retained decoder. */
function readProposalRow(
  db: Pick<WorkspaceDb, 'scope' | 'sqlite' | 'workspaceId'>,
  proposalId: string
) {
  WorkspaceIdSchema.parse(db.workspaceId);
  if (db.scope !== 'workspace')
    throw new TypeError('Knowledge Proposal requires a Workspace owner.');
  const row = db.sqlite
    .prepare('SELECT * FROM knowledge_notebook_proposals WHERE proposal_id = ?')
    .get(proposalId) as ProposalRow | undefined;
  if (!row) return null;
  const proposal = readRetainedV1(JSON.parse(row.record_json), decodeProposal);
  if (
    row.workspace_id !== db.workspaceId ||
    proposal.workspaceId !== db.workspaceId ||
    row.knowledge_base_id !== proposal.knowledgeBaseId ||
    row.proposal_id !== proposalId ||
    proposal.proposalId !== proposalId
  )
    throw new TypeError('Knowledge Proposal has inconsistent physical ownership.');
  const rawReviews: unknown = JSON.parse(row.reviews_json);
  if (!Array.isArray(rawReviews)) throw new TypeError('Knowledge Review history is not an array.');
  const reviews = validateProposalReviews(
    proposal,
    rawReviews.map((record) =>
      readRetainedV1(record, (value) => {
        requiredKnowledgeFeaturesSchema.parse(
          (value as { requiredFeatures?: unknown }).requiredFeatures
        );
        return value;
      })
    )
  );
  return { row, proposal, reviews, rawReviews };
}

/**
 * Reads dormant immutable Proposal selection and append-only Reviews on its actual Workspace.
 *
 * Null does not authorize initialization or ref/file fallback. Reading this metadata
 * does not verify the document bytes, disclose its audience or grant human Review.
 * The eventual current caller must use the referenced exact document and Git trees.
 *
 * @param db Explicit admitted physical Workspace and its caller-owned lifetime.
 * @param proposalId Original Proposal identity.
 * @returns Known immutable selection and ordered Review facts, or null when absent.
 */
export function readControlKnowledgeProposal(
  db: Pick<WorkspaceDb, 'scope' | 'sqlite' | 'workspaceId'>,
  proposalId: string
): ControlKnowledgeProposalState | null {
  const value = readProposalRow(db, proposalId);
  return value && { proposal: value.proposal, reviews: value.reviews };
}

/**
 * Prepares a dormant immutable Proposal insertion for the existing native writer.
 *
 * The caller must verify and synchronize the original document and candidate Git
 * content first. A conflicting Proposal id refuses; no metadata can be replaced.
 * This grants neither admission nor Review and has no live creation caller yet.
 *
 * @param input Exact compact facts derived from the verified original Proposal.
 * @returns One insertion for composition with its original command receipt and Audit.
 */
export function controlKnowledgeProposalStatement(
  input: ControlKnowledgeProposal
): Extract<ControlSqlStatement, { mode: 'run' }> {
  const proposal = decodeProposal({ ...input, requiredFeatures: [] });
  return {
    mode: 'run',
    sql: `INSERT INTO knowledge_notebook_proposals
          (workspace_id, knowledge_base_id, proposal_id, record_json, reviews_json)
          VALUES (?, ?, ?, ?, '[]')`,
    parameters: [
      proposal.workspaceId,
      proposal.knowledgeBaseId,
      proposal.proposalId,
      JSON.stringify(writeRetainedV1({ ...proposal, requiredFeatures: [] })),
    ],
    expectChanges: 1,
  };
}

/**
 * Prepares an append of an original Review against one exact observed native row.
 *
 * Existing decision identities, deferred/terminal order and exact candidate checks
 * remain binding. The native savepoint compares BOTH observed JSON fields before
 * appending, so a concurrent decision refuses the entire joined transition. Unknown
 * inert annotations in earlier decisions are preserved. This pure preparation
 * grants no human authority and does not advance the Notebook head on its own.
 * Accepted publication must join the head, original receipt and Audit statements.
 *
 * @param db Explicit physical Workspace used only for the observed read.
 * @param proposalId Original immutable Proposal identity.
 * @param review Original decision from the existing admitted human Review producer.
 * @returns Conditional append for the existing native savepoint and covering FULL ACK.
 */
export function controlKnowledgeReviewStatement(
  db: Pick<WorkspaceDb, 'scope' | 'sqlite' | 'workspaceId'>,
  proposalId: string,
  review: KnowledgeProposalReviewRecord
): Extract<ControlSqlStatement, { mode: 'run' }> {
  const value = readProposalRow(db, proposalId);
  if (!value) throw new TypeError('Knowledge Proposal is unavailable.');
  const reviews = validateProposalReviews(value.proposal, [...value.reviews, review]);
  const next = reviews.at(-1)!;
  return {
    mode: 'run',
    sql: `UPDATE knowledge_notebook_proposals SET reviews_json = ?
          WHERE workspace_id = ? AND knowledge_base_id = ? AND proposal_id = ?
            AND record_json = ? AND reviews_json = ?`,
    parameters: [
      JSON.stringify([...value.rawReviews, writeRetainedV1({ ...next, requiredFeatures: [] })]),
      value.row.workspace_id,
      value.row.knowledge_base_id,
      proposalId,
      value.row.record_json,
      value.row.reviews_json,
    ],
    expectChanges: 1,
  };
}

/** Pins an exact observed head without rewriting inert retained annotations. */
export function controlKnowledgeHeadGuardStatement(
  db: Pick<WorkspaceDb, 'scope' | 'sqlite' | 'workspaceId'>,
  expected: ControlKnowledgeHead
): ControlSqlStatement {
  const current = readControlKnowledgeHead(db, expected.knowledgeBaseId);
  if (!current || !isDeepStrictEqual(current, expected))
    throw new TypeError('Knowledge publication base changed.');
  const row = db.sqlite
    .prepare(
      'SELECT record_json FROM knowledge_notebook_heads WHERE workspace_id = ? AND knowledge_base_id = ?'
    )
    .get(expected.workspaceId, expected.knowledgeBaseId) as { record_json: string } | undefined;
  if (
    !row ||
    !isDeepStrictEqual(
      readRetainedV1(JSON.parse(row.record_json), decodeControlKnowledgeHead),
      expected
    )
  )
    throw new TypeError('Knowledge publication base changed.');
  return {
    mode: 'get',
    sql: 'SELECT 1 FROM knowledge_notebook_heads WHERE workspace_id = ? AND knowledge_base_id = ? AND record_json = ?',
    parameters: [expected.workspaceId, expected.knowledgeBaseId, row.record_json],
    expectRow: 'present',
  };
}
