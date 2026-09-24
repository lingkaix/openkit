---
status: Accepted
date: "2026-09-24"
decider: Engineer
supersedes: docs/decisions/20260909-active_members_full_operation_set.md
---
# Member Permissions Stay Open Until The Policy Kernel Governs Them

## Decision

Every current active member of a Workspace is eligible for its full operation set, including Light App schema and data operations, agent work, configuration, export, membership management, and governed lifecycle operations. This replaces the earlier owner, editor, and viewer grant ceiling as the design target. Policy, credentials, human gates, Vault, confidentiality, and lifecycle preconditions still decide each effect, and a member gains neither another user's private scope nor deployment administration. The design keeps room and interfaces for the Policy Kernel to govern permissions wherever policy and permission apply. Core permissions and the multi-user Workspace specification own the rule.

## Reason

The engineer gave the reason on 2026-09-24, summarized here from Chinese. The owner, editor, and viewer grading points in the right direction, and it was removed for two reasons. First, it serves fast development. Second, under fast development the project does not want a simple grading to set into the system as though it were the correct permission model, because the project intends finer grading. A separate Policy Kernel already exists, and later work will connect it step by step to every place that needs policy and permission, so the current design must leave room and interfaces for it. In the engineer's view an agent that is woken into or joins a Workspace, including a worker, is also a member of that Workspace, and work should assign finer permissions to the people and agents in it; each worker's permissions may differ. The engineer's complete design for that direction is recorded in docs/decisions/20260924-agents_are_workspace_members.md. The ceiling was removed for now so that owner, editor, and viewer would not be mistaken for the permanent model.

Source: the engineer's answer of 2026-09-24 to the landing's report, summarized above and noted in change record 202609231611190001-engineering_governance_landing; the original direction is in change record 202609081810390001-generative_kernel_ui_design, Intent Epoch 3.

## Rejected Alternatives

- Keeping the owner, editor, and viewer ceiling. Rejected because it would be taken as the settled permission model before finer grading exists.
- Per-app roles and collection or field access lists. Superseded as design targets; the finer model is expected to come through the Policy Kernel instead.

## Revisit When

The Policy Kernel is connected to the enforcement points that need permission, or finer permissions for human and agent members, including per-worker permissions, are designed.

## Affected Owners

- docs/core/permissions.md
- docs/core/identity.md
- docs/specs/20260715-multi_user_workspace_system.md
