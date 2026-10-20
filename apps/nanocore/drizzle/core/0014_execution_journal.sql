-- Existing execution authority only: selected placement and invocation clocks belong to steps.
CREATE TABLE `control_executions` (
  `id` text PRIMARY KEY NOT NULL CHECK (length(`id`) > 0),
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `owner_json` text NOT NULL CHECK (COALESCE(json_valid(`owner_json`) AND json_type(`owner_json`) = 'object' AND json_extract(`owner_json`, '$.kind') = 'server' AND json_type(`owner_json`, '$.workspaceId') IS NULL AND json_type(`owner_json`, '$.userId') IS NULL, 0)),
  `work_id` text NOT NULL CHECK (length(`work_id`) > 0),
  `definition_version` text NOT NULL CHECK (length(`definition_version`) > 0),
  `input_fingerprint` text NOT NULL CHECK (length(`input_fingerprint`) > 0),
  `phase` text NOT NULL CHECK (`phase` IN ('open', 'closing', 'closed')),
  `revision` integer NOT NULL CHECK (typeof(`revision`) = 'integer' AND `revision` BETWEEN 1 AND 9007199254740991),
  `terminal_cause` text,
  `exclusion_refs_json` text NOT NULL CHECK (COALESCE(json_valid(`exclusion_refs_json`) AND json_type(`exclusion_refs_json`) = 'array', 0)),
  `span_json` text NOT NULL CHECK (COALESCE(json_valid(`span_json`) AND json_type(`span_json`) = 'object' AND json_type(`span_json`, '$.startTimeUnixNano') = 'text' AND json_type(`span_json`, '$.endTimeUnixNano') IN ('text', 'null'), 0))
);
--> statement-breakpoint
CREATE TABLE `control_execution_steps` (
  `execution_id` text NOT NULL REFERENCES `control_executions` (`id`),
  `step_id` text NOT NULL CHECK (length(`step_id`) > 0),
  `schema_version` integer NOT NULL CHECK (`schema_version` = 1),
  `ordinal` integer NOT NULL CHECK (typeof(`ordinal`) = 'integer' AND `ordinal` BETWEEN 1 AND 9007199254740991),
  `parent_step_id` text CHECK (`parent_step_id` IS NULL OR `parent_step_id` <> `step_id`),
  `state` text NOT NULL CHECK (`state` IN ('intent', 'completed', 'failed', 'unknown', 'cancelled')),
  `invocation_id` text NOT NULL CHECK (length(`invocation_id`) > 0),
  `control_json` text NOT NULL CHECK (COALESCE(json_valid(`control_json`) AND json_type(`control_json`) = 'object' AND json_type(`control_json`, '$.definitionVersion') = 'text' AND json_extract(`control_json`, '$.kind') IN ('admit', 'queue-capacity-wait', 'reserve', 'resolve-setup', 'validate-setup', 'materialize', 'open-session', 'inspect-session', 'deliver-start', 'observe', 'collect', 'terminal-publication', 'cancel', 'human-wait', 'consume-receipt', 'inspect-cleanup', 'fence', 'release') AND json_type(`control_json`, '$.workId') = 'text' AND json_extract(`control_json`, '$.invocationId') = `invocation_id` AND json_type(`control_json`, '$.actor') = 'object' AND json_type(`control_json`, '$.inputRefs') = 'array' AND json_type(`control_json`, '$.outputRefs') = 'array' AND json_type(`control_json`, '$.authorityRefs') = 'array' AND json_type(`control_json`, '$.physicalFenceRefs') = 'array' AND json_type(`control_json`, '$.retryPermitted') IN ('true', 'false') AND json_type(`control_json`, '$.deadlineUnixNano') IN ('text', 'null') AND json_type(`control_json`, '$.target') IN ('object', 'null'), 0)),
  `invocation_json` text NOT NULL CHECK (COALESCE(json_valid(`invocation_json`) AND json_type(`invocation_json`) = 'object' AND json_type(`invocation_json`, '$.parent') IN ('object', 'null') AND json_type(`invocation_json`, '$.carriage') = 'object' AND json_type(`invocation_json`, '$.clock') = 'object' AND json_type(`invocation_json`, '$.clock.processWitness') = 'text' AND json_type(`invocation_json`, '$.clock.admittedUnixNano') = 'text' AND json_type(`invocation_json`, '$.clock.admittedMonotonicNano') = 'text' AND json_type(`invocation_json`, '$.remainingMs') IS NULL, 0)),
  `span_json` text NOT NULL CHECK (COALESCE(json_valid(`span_json`) AND json_type(`span_json`) = 'object' AND json_type(`span_json`, '$.startTimeUnixNano') = 'text' AND json_type(`span_json`, '$.endTimeUnixNano') IN ('text', 'null'), 0)),
  `inspected_execution_id` text,
  `inspected_step_id` text,
  PRIMARY KEY (`execution_id`, `step_id`),
  FOREIGN KEY (`execution_id`, `parent_step_id`) REFERENCES `control_execution_steps` (`execution_id`, `step_id`),
  FOREIGN KEY (`inspected_execution_id`, `inspected_step_id`) REFERENCES `control_execution_steps` (`execution_id`, `step_id`),
  CHECK ((`inspected_execution_id` IS NULL) = (`inspected_step_id` IS NULL)),
  CHECK (`inspected_execution_id` IS NULL OR `inspected_execution_id` <> `execution_id` OR `inspected_step_id` <> `step_id`),
  CHECK (COALESCE((`state` = 'intent' AND json_type(`span_json`, '$.endTimeUnixNano') = 'null') OR (`state` <> 'intent' AND json_type(`span_json`, '$.endTimeUnixNano') = 'text'), 0)),
  CHECK (`state` <> 'unknown' OR COALESCE(json_extract(`span_json`, '$.status.code') = 'ERROR', 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_execution_steps_order_idx` ON `control_execution_steps` (`execution_id`, `ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_execution_steps_invocation_idx` ON `control_execution_steps` (`invocation_id`);
--> statement-breakpoint
CREATE INDEX `control_execution_steps_state_idx` ON `control_execution_steps` (`execution_id`, `state`, `ordinal`);
--> statement-breakpoint
CREATE INDEX `control_execution_steps_inspection_idx` ON `control_execution_steps` (`inspected_execution_id`, `inspected_step_id`, `execution_id`, `ordinal`);
--> statement-breakpoint
-- Parent ordering is admission order, not completion or result-delivery history.
CREATE TRIGGER `control_execution_steps_parent_prior` BEFORE INSERT ON `control_execution_steps`
WHEN NEW.`parent_step_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `control_execution_steps` WHERE `execution_id` = NEW.`execution_id` AND `step_id` = NEW.`parent_step_id` AND `ordinal` < NEW.`ordinal`
)
BEGIN SELECT RAISE(ABORT, 'Execution parent must be a prior step in the same execution.'); END;
--> statement-breakpoint
CREATE TRIGGER `control_execution_steps_root_identity` BEFORE INSERT ON `control_execution_steps`
WHEN NOT EXISTS (
  SELECT 1 FROM `control_executions` WHERE `id` = NEW.`execution_id`
    AND `work_id` = json_extract(NEW.`control_json`, '$.workId')
    AND `definition_version` = json_extract(NEW.`control_json`, '$.definitionVersion')
)
BEGIN SELECT RAISE(ABORT, 'Execution step control must match its root identity.'); END;
--> statement-breakpoint
CREATE TRIGGER `control_executions_identity_immutable` BEFORE UPDATE ON `control_executions`
WHEN NEW.`id` IS NOT OLD.`id` OR NEW.`schema_version` IS NOT OLD.`schema_version`
  OR NEW.`owner_json` IS NOT OLD.`owner_json` OR NEW.`work_id` IS NOT OLD.`work_id`
  OR NEW.`definition_version` IS NOT OLD.`definition_version` OR NEW.`input_fingerprint` IS NOT OLD.`input_fingerprint`
  OR json_extract(NEW.`span_json`, '$.traceId') IS NOT json_extract(OLD.`span_json`, '$.traceId')
  OR json_extract(NEW.`span_json`, '$.spanId') IS NOT json_extract(OLD.`span_json`, '$.spanId')
  OR json_extract(NEW.`span_json`, '$.startTimeUnixNano') IS NOT json_extract(OLD.`span_json`, '$.startTimeUnixNano')
  OR (OLD.`phase` = 'closed' AND NEW.`phase` <> 'closed')
BEGIN SELECT RAISE(ABORT, 'Execution identity is immutable and closed executions cannot reopen.'); END;
--> statement-breakpoint
-- The original invocation, control input and trace identity cannot be renewed at settlement.
CREATE TRIGGER `control_execution_steps_settle_once` BEFORE UPDATE ON `control_execution_steps`
WHEN OLD.`state` <> 'intent' OR NEW.`state` = 'intent'
  OR NEW.`execution_id` IS NOT OLD.`execution_id` OR NEW.`step_id` IS NOT OLD.`step_id`
  OR NEW.`schema_version` IS NOT OLD.`schema_version` OR NEW.`ordinal` IS NOT OLD.`ordinal`
  OR NEW.`parent_step_id` IS NOT OLD.`parent_step_id` OR NEW.`invocation_id` IS NOT OLD.`invocation_id`
  OR NEW.`inspected_execution_id` IS NOT OLD.`inspected_execution_id` OR NEW.`inspected_step_id` IS NOT OLD.`inspected_step_id`
  OR NEW.`invocation_json` IS NOT OLD.`invocation_json`
  OR json_remove(NEW.`control_json`, '$.outputRefs') IS NOT json_remove(OLD.`control_json`, '$.outputRefs')
  OR json_extract(NEW.`span_json`, '$.traceId') IS NOT json_extract(OLD.`span_json`, '$.traceId')
  OR json_extract(NEW.`span_json`, '$.spanId') IS NOT json_extract(OLD.`span_json`, '$.spanId')
  OR json_extract(NEW.`span_json`, '$.parentSpanId') IS NOT json_extract(OLD.`span_json`, '$.parentSpanId')
  OR json_extract(NEW.`span_json`, '$.startTimeUnixNano') IS NOT json_extract(OLD.`span_json`, '$.startTimeUnixNano')
  OR json_extract(NEW.`span_json`, '$.name') IS NOT json_extract(OLD.`span_json`, '$.name')
  OR json_extract(NEW.`span_json`, '$.kind') IS NOT json_extract(OLD.`span_json`, '$.kind')
BEGIN SELECT RAISE(ABORT, 'Execution step identity is immutable and an outcome settles once.'); END;
