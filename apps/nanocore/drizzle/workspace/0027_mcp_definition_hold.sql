-- Historical and imported observations carry no implicit definition approval.
ALTER TABLE `mcp_tool_schema_snapshots` ADD `approved_schema_digest` text;
