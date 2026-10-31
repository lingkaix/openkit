import { sql } from 'drizzle-orm';
import { check, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Dormant Workspace Knowledge selection; activation also requires its complete command and migration closure. */
export const knowledgeNotebookHeads = sqliteTable(
  'knowledge_notebook_heads',
  {
    /** Explicit physical Workspace owner, never inferred from a repository path. */
    workspaceId: text('workspace_id').notNull(),
    /** Globally identified Knowledge Base whose Git and schema heads are selected together. */
    knowledgeBaseId: text('knowledge_base_id').primaryKey().notNull(),
    /** Retained v1 tuple; its family decoder checks exact immutable identities and required semantics. */
    recordJson: text('record_json').notNull(),
  },
  (table) => [check('knowledge_notebook_heads_json_check', sql`json_valid(${table.recordJson})`)]
);

/** Dormant immutable Proposal metadata and its existing append-only ordered Review values. */
export const knowledgeNotebookProposals = sqliteTable(
  'knowledge_notebook_proposals',
  {
    /** Exact physical Workspace, checked by the row owner. */
    workspaceId: text('workspace_id').notNull(),
    /** Existing Knowledge Base containing the immutable document and candidate. */
    knowledgeBaseId: text('knowledge_base_id').notNull(),
    /** Original immutable Proposal identity, never a new decision counter. */
    proposalId: text('proposal_id').primaryKey().notNull(),
    /** Retained-v1 compact facts and original document descriptor; never updated. */
    recordJson: text('record_json').notNull(),
    /** Existing retained Review entries in append order, changed only by exact observed-row CAS. */
    reviewsJson: text('reviews_json').notNull(),
  },
  (table) => [
    check('knowledge_notebook_proposals_record_check', sql`json_valid(${table.recordJson})`),
    check(
      'knowledge_notebook_proposals_reviews_check',
      sql`json_valid(${table.reviewsJson}) AND json_type(${table.reviewsJson}) = 'array'`
    ),
  ]
);
