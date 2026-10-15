---
status: Accepted
date: "2026-10-15"
decider: Engineer
---
# Cleanup View, Agent Pinning, And Delegated Apply Rulings

## Decision

- #226: expose an administrator-only, read-only cleanup view derived from existing authoritative records. Show source, target identity, current state, and next action. Missing or uncertain evidence remains unknown. Add no cleanup state machine, runner, or durable summary.
- #134: keep the conversation catalog's Workspace-pinned Agent boundary and provide a clear pin path. Exact #133 selection still operates within the eligible set and may select an eligible unpinned Agent. The conversation target pins do not filter general Agent inventory or direct Task eligibility.
- D06: admit the first delegated apply scope only for registered Worker network-policy Git-read corrections. Reuse current revision, Policy, command receipt, and Audit owners. Report persistence and reload separately. No whole-service recovery, credential change, or authority expansion is admitted.

## Reason

Source: engineer-rulings-20261015.md, Resulting rulings and Confirmation and expanded delegation, in the coordinator's backlog-20261015 working record. The engineer accepted all other recommended first options on 2026-10-15, including the decisions-zh.md rows #226, #134, and D06. The coordinator explicitly commissioned this second amendment group. The external ruling record is source evidence, not a replacement design owner.

The cleanup view makes retained blockers inspectable without adding lifecycle authority. Pinning preserves explicit Workspace supply while making that prerequisite discoverable. Narrow delegated maintenance completes the previously accepted delegation ceiling for one finite action instead of admitting general configuration or service repair.

P07 supplied the concrete source and affected-scope clarification in P07-owner-amendment-request.md through the coordinator. Its reviewer found no ruling drift. Independent Astra scrutiny requested complete Chat exceptions and exact source-scope binding; the owner realization incorporates those corrections. The independent Astra Consultant agreed after recheck, recorded in backlog-20261015/reviews/P11-group2-consultant-recheck.md, under the engineer's expanded delegation. The executable Policy-assignment mechanism remains a named dependency, not invented authority.

## Rejected Alternatives

- A new cleanup state machine duplicates existing lifecycle owners.
- Exposing global unpinned Agents changes the selected catalog boundary.
- General delegated configuration, new egress authority, or service recovery exceeds the selected first apply scope.

## Revisit When

Revisit if a named cleanup source lacks an authoritative observation, Workspace pinning prevents an accepted workflow, or another maintenance action needs admission. Broader scope requires its owner first.

## Affected Owners

- [Multi-User Workspace System](../specs/20260715-multi_user_workspace_system.md)
- [Unified Conversation Composer](../specs/20260831-unified_conversation_composer.md)
- [Delegated Worker Policy Maintenance](../specs/20260922-delegated_worker_policy_maintenance.md)
- [Chat Mode And Core Assistant](../specs/20260704-chat_mode_assistant.md)
- [Internal Agent Resource Integration](../specs/20260909-internal_agent_resource_integration.md)
