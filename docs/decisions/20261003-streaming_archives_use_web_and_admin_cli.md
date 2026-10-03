---
status: Accepted
date: "2026-10-03"
decider: Coordinator, under the engineer's standing delegation to decide in the engineer's absence, on an independent Consultant's analysis
---
# Streaming Archives Use Web And Administrator CLI

## Decision

The Coordinator adopted an exception to first-release remote MCP coverage: the three definition-owned Workspace archive operations retain their streaming bindings through Web and the administrator CLI. Remote MCP omits them from search and describe, refuses call before archive processing with a typed unsupported-operation result, and directs users to those channels through guide. [Operation Definition](../specs/20261002-operation_definition.md#remote-mcp-projection) owns projection; [OpenKit Agent Skill Interface](../specs/20260713-openkit_agent_skill_interface.md#live-product-use-and-acceptance) counts demonstrated Web and administrator CLI archive coverage toward Skill retirement. This revises the earlier expectation of remote MCP coverage for every non-secret operation; it does not provide ordinary users an equivalent agent archive channel.

## Reason

The archive owner forbids complete buffering, reusable uploads, and base64 or server-path delivery. The current invocation and client serialize logical JSON results. Retaining existing streaming channels is the smallest coherent release route without an archive transport mechanism. The Consultant explicitly treated exclusion as a release trade-off, not proof that MCP cannot carry archives, and asked for an engineer ruling. Under the engineer's standing delegation during absence, the Coordinator adopted the recommendation.

Source decision: temp/comm-redesign/engineer-queue.md, entry "Migration owner gaps", gap 1, dated 2026-10-03. Source analysis: temp/interface-unification/reports/migration-owner-gaps/consult-report.md. Landing commit: c00985b79ff8ad0b7f652d15a2848e26ad542ebd. These are provenance references, not behavioral authority.

## Rejected Alternatives

- An archive transport over MCP: it would require a new mechanism under the archive owner's restrictions; the Coordinator retained existing streaming channels instead.
- A spool, upload handle, download proxy, or general transport framework: the Consultant found this machinery unnecessary for the selected release route.

## Revisit When

None recorded.

## Affected Owners

- [Operation Definition](../specs/20261002-operation_definition.md)
- [Remote MCP Interface](../specs/20261002-remote_mcp_interface.md)
- [Workspace Backup, Export, Import, And Data-Root Migration](../specs/20260704-workspace_backup_export_import.md)
- [OpenKit Agent Skill Interface](../specs/20260713-openkit_agent_skill_interface.md)
- [Agent Operator Skill](../specs/20260910-agent_operator_skill.md)
- [Release Management](../specs/20260829-release_management.md)
