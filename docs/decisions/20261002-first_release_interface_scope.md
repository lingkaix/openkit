---
status: Superseded
superseded-by: docs/decisions/20261002-first_release_interface_scope_revised.md
date: "2026-10-02"
decider: Engineer, on the coordinator's recommendation
---
# The First Release Ships One Interface Design

## Decision

The engineer set the first-release scope of the interface redesign on 2026-10-02.

1. Remote MCP and a core set of operation families come first. The design is finished before implementation, and the smallest implementation then fixes the architecture and its tone. The core set is the Task journey an external coding agent needs: Workspace discovery, shared Thread creation and reading, Turn reading, Task start and conversation, Pending Request discovery and decisions, Artifact reading and Knowledge lookup and preparation, together with the repository push and workspace-sync review read and decision operations that let the agent carry a GitHub issue to a pull request under the existing approvals.
2. Before the first release, every remaining existing operation moves mechanically into the definition tables of [Operation Definition](../specs/20261002-operation_definition.md), and each migrated family deletes its old route, client mapping, descriptor and hand-written CLI catalog entry. The migration adds no new feature. Full functional coverage of the Product Vision stays later work.
3. The first release implements the accepted [Goal](../specs/20261002-goal.md) and deletes the old Goal implementation in the same change, as that owner's one-way data removal requires.
4. The user-facing Skill and its bundled CLI retire in the first release once the remote MCP endpoint reaches the release's operations and serves `guide`. The definition-derived administrator CLI stays under [Agent Operator Skill](../specs/20260910-agent_operator_skill.md) with full administrator coverage, and one-time secrets stay out of every MCP path.
5. Documents, architecture statements and implementations written for the old interface design are removed or moved to the new design rather than left beside it.

## Reason

Translated from Chinese. The engineer: "Prioritize remote MCP plus several core operation families. First finish all the design, then fix the architecture and its tone through the smallest implementation. Full coverage of all functions is left for later. But if the system still contains documents, architecture design or implementation from the old design, those must all be cleaned out and moved to the new design, so that our architecture, interfaces and implementation stay clean."

A read-only inventory then found 247 existing callable operations, of which the Task journey needs 18, and showed that migrating only the core set would leave the other operations on hand-written routes, client mappings and a hand-written CLI catalog beside the new definitions. The engineer chose the coordinator's recommended answer to each of the four scope questions that followed: migrate every remaining existing operation mechanically before release, implement the new Goal and delete the old one, retire the user-facing Skill in the first release, and include the repository push and workspace-sync review operations in the core set. Time is short before the first release, so mechanical migration adds no feature while still shipping one design.

Source: change record 202610020440000000-interface_unification, inventory `temp/interface-unification/reports/research-first-release-families.md`.

## Rejected Alternatives

- Migrate only the core set and leave the other operations on their old surfaces until a later release. Rejected; two interface designs would ship side by side.
- Migrate the core set and withdraw every unmigrated family from the release. Rejected; it deletes working features to obtain a clean surface.
- Delete the old Goal implementation and ship no Goal mode until a later release. Rejected; the accepted Goal design is implemented now.
- Keep the user-facing Skill beside remote MCP until a later release. Rejected; with every non-secret operation migrated, remote MCP covers the Skill in this release.
- Leave the publication operations out of the core set and approve pushes only on the Web. Rejected; the external agent must be able to carry an issue to a pull request.

## Revisit When

The first-release schedule cannot absorb the mechanical migration or the Goal replacement, and the engineer narrows the release scope.

## Affected Owners

- docs/specs/20261002-operation_definition.md
- docs/specs/20261002-remote_mcp_interface.md
- docs/specs/20260713-openkit_agent_skill_interface.md
- docs/specs/20260910-agent_operator_skill.md
- docs/specs/20261002-goal.md
- docs/roadmap.md
