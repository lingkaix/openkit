import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Private Server-owned image outcomes; no foreign key ties settlement to candidate lifetime. */
export const workerImageSettlements = sqliteTable('worker_image_settlements', {
  /** Deterministic preparation effect identity. */
  requestId: text('request_id').primaryKey().notNull(),
  /** Closed acquisition or build operation. */
  operation: text('operation').notNull(),
  /** Immutable authored candidate id. */
  authoredArtifactId: text('authored_artifact_id').notNull(),
  /** Create-only candidate version. */
  authoredArtifactVersion: integer('authored_artifact_version').notNull(),
  /** Authored candidate content digest. */
  authoredContentDigest: text('authored_content_digest').notNull(),
  /** Canonical image declaration digest. */
  inputDigest: text('input_digest').notNull(),
  /** Definite success or failure. */
  outcome: text('outcome').notNull(),
  /** Verified digest on success only. */
  imageDigest: text('image_digest'),
  /** Exact effect_failed code on failure only. */
  failureCode: text('failure_code'),
  /** First persistence time, excluded from duplicate comparison. */
  createdAt: text('created_at').notNull(),
});
