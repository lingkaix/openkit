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
