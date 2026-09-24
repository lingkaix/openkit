---
status: Accepted
date: "2026-09-24"
decider: Engineer
---
# Agents Are Workspace Members With Their Own Permission Scopes

## Decision

An agent that is woken into or joins a Workspace, including a worker and the product Orchestrator, is a member of that Workspace in the permission design, and people and agents receive finer permissions than an owner, editor, and viewer grading; each worker's permissions may differ. The product Orchestrator will later manage and grant permissions to the workers within its dispatch scope, so the Orchestrator and its workers hold different permission levels and scopes. The Policy Kernel is the mechanism for this finer grading and will be connected step by step to every place that needs policy and permission. This is a direction for the permission design: current membership is still defined for users, and current design must not preclude agent membership or finer grading. Agent membership lifecycle and the Orchestrator's granting of permissions are designed in their own changes under Core identity and permissions.

## Reason

The engineer stated the design on 2026-09-24, summarized here from Chinese, as the complete idea behind removing the owner, editor, and viewer ceiling. That the product Orchestrator will grant permissions to the workers it dispatches shows that agents need distinct permission levels and scopes, and that fine-grained granting to different workers cannot be expressed by an owner, editor, and read grading alone; the Policy Kernel is needed for it.

Source: the engineer's answers of 2026-09-24 to the landing's report, noted in change record 202609231611190001-engineering_governance_landing.

## Rejected Alternatives

- Owner, editor, and viewer grading as the permission model. Rejected as insufficient for granting different permissions to different workers.

## Revisit When

Agent membership or the Orchestrator's granting of permissions is designed.

## Affected Owners

- docs/core/identity.md
- docs/core/permissions.md
- docs/specs/20260715-multi_user_workspace_system.md
- docs/specs/20260704-goal_mode_coordination.md
