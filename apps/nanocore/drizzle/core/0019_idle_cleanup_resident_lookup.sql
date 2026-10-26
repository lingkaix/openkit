-- Derived Core-only lookup; original identity and receipt semantics are unchanged.
CREATE INDEX `control_execution_steps_idle_resident_idx`
ON `control_execution_steps` (json_extract(`invocation_json`, '$.carriage.bindingRef'))
WHERE json_extract(`control_json`, '$.definitionVersion') = 'core-idle-cleanup/v1'
  AND json_extract(`invocation_json`, '$.carriage.operation') IN ('bridge.close', 'sandbox.delete')
  AND json_extract(`control_json`, '$.kind') <> 'consume-receipt';
