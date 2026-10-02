---
status: Accepted
date: "2026-10-02"
decider: Engineer
supersedes: docs/decisions/20261002-first_release_interface_scope.md
---
# The First Release Interface Scope, Revised

## Decision

The engineer revised the first-release scope of the interface redesign on 2026-10-02. This record replaces [The First Release Ships One Interface Design](20261002-first_release_interface_scope.md). Items 2 to 5 of that record are unchanged. Item 1 no longer includes host repository push or its approvals.

1. Remote MCP and a core set of operation families come first. The design is finished before implementation, and the smallest implementation then fixes the architecture and its tone. The core set is the Task journey an external coding agent needs: Workspace discovery, shared Thread creation and reading, Turn reading, Task start and conversation, Pending Request discovery and decisions, Artifact reading and Knowledge lookup and preparation. The external agent carries a GitHub issue to a pull request by starting a Task whose worker uses the Gateway-mediated GitHub MCP under per-tool approvals answered through the core Pending Request operations. Workspace synchronization review operations stay in the release as the non-Git apply path and move through the ordinary mechanical migration in item 2.
2. Before the first release, every remaining existing operation moves mechanically into the definition tables of [Operation Definition](../specs/20261002-operation_definition.md), and each migrated family deletes its old route, client mapping, descriptor and hand-written CLI catalog entry. The migration adds no new feature. Full functional coverage of the Product Vision stays later work.
3. The first release implements the accepted [Goal](../specs/20261002-goal.md) and deletes the old Goal implementation in the same change, as that owner's one-way data removal requires.
4. The user-facing Skill and its bundled CLI retire in the first release once the remote MCP endpoint reaches the release's operations and serves `guide`. The definition-derived administrator CLI stays under [Agent Operator Skill](../specs/20260910-agent_operator_skill.md) with full administrator coverage, and one-time secrets stay out of every MCP path.
5. Documents, architecture statements and implementations written for the old interface design are removed or moved to the new design rather than left beside it.

## Reason

The superseded record put repository push and its approvals in the core set so an external agent could carry a GitHub issue to a pull request. The engineer then retired the NanoCore host Git publication path, as recorded in [Hosting Goes Through The Gateway MCP](20261002-hosting_through_gateway_mcp.md). The issue-to-pull-request outcome remains. It is now a Task whose worker uses the Gateway-mediated GitHub MCP, with per-tool approvals answered through the core Pending Request operations. Workspace synchronization review operations stay in the release as the non-Git apply path through the ordinary mechanical migration. Items 2 to 5 are restated unchanged.

Translated from Chinese. The engineer: "Prioritize remote MCP plus several core operation families. First finish all the design, then fix the architecture and its tone through the smallest implementation. Full coverage of all functions is left for later. But if the system still contains documents, architecture design or implementation from the old design, those must all be cleaned out and moved to the new design, so that our architecture, interfaces and implementation stay clean."

A read-only inventory then found 247 existing callable operations, of which the Task journey needs 18, and showed that migrating only the core set would leave the other operations on hand-written routes, client mappings and a hand-written CLI catalog beside the new definitions.

Time is short before the first release, so mechanical migration adds no feature while still shipping one design.

## Rejected Alternatives

- Keep host repository push and its approvals in the core set. Rejected because the engineer retired the NanoCore host Git publication path.
- Drop the issue-to-pull-request outcome from the first release. Rejected. The external agent still carries a GitHub issue to a pull request, through the Gateway-mediated GitHub MCP.
- Remove Workspace synchronization review operations from the release. Rejected. They stay as the non-Git apply path and move through the ordinary mechanical migration.
- Migrate only the core set and leave the other operations on their old surfaces until a later release. Rejected; two interface designs would ship side by side.
- Migrate the core set and withdraw every unmigrated family from the release. Rejected; it deletes working features to obtain a clean surface.
- Delete the old Goal implementation and ship no Goal mode until a later release. Rejected; the accepted Goal design is implemented now.
- Keep the user-facing Skill beside remote MCP until a later release. Rejected; with every non-secret operation migrated, remote MCP covers the Skill in this release.

## Revisit When

The first-release schedule cannot absorb the mechanical migration or the Goal replacement, and the engineer narrows the release scope. The engineer stated no separate revisit trigger for the hosting replacement.

## Affected Owners

- docs/decisions/20261002-first_release_interface_scope.md
- docs/decisions/20261002-hosting_through_gateway_mcp.md
- docs/specs/20261002-operation_definition.md
- docs/specs/20261002-remote_mcp_interface.md
- docs/specs/20260713-openkit_agent_skill_interface.md
- docs/specs/20260910-agent_operator_skill.md
- docs/specs/20261002-goal.md
- docs/roadmap.md
- docs/specs/20260703-workspace_synchronization.md
- docs/specs/20260930-pending_requests.md
