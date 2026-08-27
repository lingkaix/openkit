import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable configured NanoHost identity, readiness, and fixed-slot declaration. */
export const nanohostRuntimeTargets = sqliteTable('nanohost_runtime_targets', {
  /** Stable configured scheduler target id. */
  targetId: text('target_id').primaryKey().notNull(),
  /** Configured NanoHost IntegrationIdentity id. */
  identityId: text('identity_id').notNull(),
  /** Deployment binding for the configured NanoHost. */
  deploymentId: text('deployment_id').notNull(),
  /** Monotonic authoritative transport connection generation. */
  connectionGeneration: integer('connection_generation').notNull(),
  /** Whether the predecessor connection is fenced. */
  predecessorFenced: integer('predecessor_fenced', { mode: 'boolean' }).notNull(),
  /** Whether the current generation reports ready admission. */
  ready: integer('ready', { mode: 'boolean' }).notNull(),
  /** Whether the current generation proved a fresh empty Runtime Epoch. */
  freshEmpty: integer('fresh_empty', { mode: 'boolean' }).notNull(),
  /** Timestamp of the current readiness observation. */
  observedAt: text('observed_at').notNull(),
  /** Fixed V1 worker-slot declaration; scheduler rows own capacity. */
  slotCount: integer('slot_count').notNull(),
  /** Last accepted fresh-empty readiness boundary, retained across connection close. */
  lastFreshReadyAt: text('last_fresh_ready_at'),
});
