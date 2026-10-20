import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** Core-owned execution identity and root span; placement belongs to each step, never this row. */
export const controlExecutions = sqliteTable(
  'control_executions',
  {
    id: text('id').primaryKey().notNull(),
    schemaVersion: integer('schema_version').notNull(),
    ownerJson: text('owner_json').notNull(),
    workId: text('work_id').notNull(),
    definitionVersion: text('definition_version').notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    phase: text('phase').$type<'open' | 'closing' | 'closed'>().notNull(),
    revision: integer('revision').notNull(),
    terminalCause: text('terminal_cause'),
    exclusionRefsJson: text('exclusion_refs_json').notNull(),
    /** Lossless journal JSON: bigint times and typed int64 values use exact decimal strings. */
    spanJson: text('span_json').notNull(),
  },
  (table) => [
    check('control_executions_version_check', sql`${table.schemaVersion} = 1`),
    check('control_executions_phase_check', sql`${table.phase} IN ('open', 'closing', 'closed')`),
    check(
      'control_executions_revision_check',
      sql`${table.revision} BETWEEN 1 AND 9007199254740991`
    ),
    check(
      'control_executions_owner_check',
      sql`json_valid(${table.ownerJson}) AND json_type(${table.ownerJson}) = 'object'`
    ),
    check(
      'control_executions_exclusion_check',
      sql`json_valid(${table.exclusionRefsJson}) AND json_type(${table.exclusionRefsJson}) = 'array'`
    ),
    check(
      'control_executions_span_check',
      sql`json_valid(${table.spanJson}) AND json_type(${table.spanJson}) = 'object'`
    ),
  ]
);

/** Original intent/outcome with independent parent and inspection links; native SQL guards immutable identities and ended rows. */
export const controlExecutionSteps = sqliteTable(
  'control_execution_steps',
  {
    executionId: text('execution_id')
      .notNull()
      .references(() => controlExecutions.id),
    stepId: text('step_id').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    ordinal: integer('ordinal').notNull(),
    parentStepId: text('parent_step_id'),
    state: text('state')
      .$type<'intent' | 'completed' | 'failed' | 'unknown' | 'cancelled'>()
      .notNull(),
    invocationId: text('invocation_id').notNull(),
    /** Exact control including the selected step target; outputRefs may be added only at settlement. */
    controlJson: text('control_json').notNull(),
    /** Original {parent, carriage, clock}; no persisted remainingMs or renewed invocation budget. */
    invocationJson: text('invocation_json').notNull(),
    spanJson: text('span_json').notNull(),
    inspectedExecutionId: text('inspected_execution_id'),
    inspectedStepId: text('inspected_step_id'),
  },
  (table) => [
    primaryKey({ columns: [table.executionId, table.stepId] }),
    uniqueIndex('control_execution_steps_order_idx').on(table.executionId, table.ordinal),
    uniqueIndex('control_execution_steps_invocation_idx').on(table.invocationId),
    index('control_execution_steps_state_idx').on(table.executionId, table.state, table.ordinal),
    index('control_execution_steps_inspection_idx').on(
      table.inspectedExecutionId,
      table.inspectedStepId,
      table.executionId,
      table.ordinal
    ),
    foreignKey({
      columns: [table.executionId, table.parentStepId],
      foreignColumns: [table.executionId, table.stepId],
    }),
    foreignKey({
      columns: [table.inspectedExecutionId, table.inspectedStepId],
      foreignColumns: [table.executionId, table.stepId],
    }),
    check('control_execution_steps_version_check', sql`${table.schemaVersion} = 1`),
    check(
      'control_execution_steps_ordinal_check',
      sql`${table.ordinal} BETWEEN 1 AND 9007199254740991`
    ),
    check(
      'control_execution_steps_state_check',
      sql`${table.state} IN ('intent', 'completed', 'failed', 'unknown', 'cancelled')`
    ),
    check(
      'control_execution_steps_parent_check',
      sql`${table.parentStepId} IS NULL OR ${table.parentStepId} <> ${table.stepId}`
    ),
    check(
      'control_execution_steps_inspection_pair_check',
      sql`(${table.inspectedExecutionId} IS NULL) = (${table.inspectedStepId} IS NULL)`
    ),
    check(
      'control_execution_steps_not_self_inspection_check',
      sql`${table.inspectedExecutionId} IS NULL OR ${table.inspectedExecutionId} <> ${table.executionId} OR ${table.inspectedStepId} <> ${table.stepId}`
    ),
    check(
      'control_execution_steps_control_check',
      sql`json_valid(${table.controlJson}) AND json_type(${table.controlJson}) = 'object'`
    ),
    check(
      'control_execution_steps_invocation_check',
      sql`json_valid(${table.invocationJson}) AND json_type(${table.invocationJson}) = 'object'`
    ),
    check(
      'control_execution_steps_span_check',
      sql`json_valid(${table.spanJson}) AND json_type(${table.spanJson}) = 'object'`
    ),
  ]
);
