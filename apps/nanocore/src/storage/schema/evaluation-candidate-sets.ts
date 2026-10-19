import type { CandidateSetRecord } from '@openkit/app-api-schemas';
import { sql } from 'drizzle-orm';
import { check, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** One Workspace-owned family retains immutable membership and append-only human selections. */
export const evaluationCandidateSets = sqliteTable(
  'evaluation_candidate_sets',
  {
    /** Workspace whose existing SQLite transaction owns the record and command receipt. */
    workspaceId: text('workspace_id').notNull(),
    /** Accepted creation request identity within this Workspace; no global entity prefix is allocated. */
    candidateSetId: text('candidate_set_id').notNull(),
    /** Closed retained shape with descriptive extensions, membership and ordered selection history. */
    payloadJson: text('payload_json', { mode: 'json' }).$type<CandidateSetRecord>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.candidateSetId] }),
    check('evaluation_candidate_sets_identity_check', sql`length(${table.candidateSetId}) > 0`),
    check('evaluation_candidate_sets_payload_check', sql`json_valid(${table.payloadJson})`),
  ]
);
