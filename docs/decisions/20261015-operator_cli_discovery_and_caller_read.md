---
status: Accepted
date: "2026-10-15"
decider: Coordinator, under the engineer's accepted owner-alignment scope
---
# Operator CLI Discovery And Current Caller Read

## Decision

The CLI owner admits local help, compact search and describe results, explicit full-schema output, and discovery aliases for existing update operations. Aliases do not create operation identities. The same owner defines the minimal secret-safe caller response before public schema implementation.

`caller.read` returns current caller identity and credential kind/scope. An explicit owned Workspace selection adds bounded identifiers and audience-filtered record counts. Administrator eligibility stays separate from actual ownership and membership. No global content visibility, principal, authorization rule, or durable state is added.

## Reason

The coordinator requested this early P11 owner amendment on 2026-10-15 for P12, branch `rc8/p12-contracts-cli`. The coordinator classified #236 and the minimal #235 response as ordinary owner alignment under the engineer's accepted scope. The shared dispatch evidence is backlog-20261015/decisions-zh.md, header, and inventory rows i008 and i291. This record preserves that source; those working files are not design authority.

[#236](https://github.com/lingkaix/openkit/issues/236) records unusable help and large nested discovery schemas during an update. [#235](https://github.com/lingkaix/openkit/issues/235) records missing caller readback and administrator eligibility presented as ownership. Existing Identity, Permissions, and Multi-User Workspace owners already require truthful attribution and preserve actual relationships.

## Rejected Alternatives

- A separate update command catalog or business workflow in the CLI duplicates operation ownership.
- A global administrator content inventory expands the requested current-caller read.
- Treating administrator access as ownership contradicts the canonical Workspace registry.

## Revisit When

Revisit if a demonstrated operator task needs more caller metadata or a broader retained-work observation. Any audience or authority expansion requires its owning decision first.

## Affected Owners

- [Agent Operator Skill](../specs/20260910-agent_operator_skill.md)
- [Multi-User Workspace System](../specs/20260715-multi_user_workspace_system.md)
