---
status: Superseded
superseded-by: docs/decisions/20260924-member_permissions_await_policy_kernel.md
date: "2026-09-09"
decider: Engineer
---
# Every Active Member Is Eligible For The Full Workspace Operation Set

## Decision

Every current active member of a Workspace is eligible for its full operation set, including Light App schema and data operations, agent work, configuration, export, membership management, and governed lifecycle operations. This replaces the earlier owner, editor, and viewer grant ceiling as the design target. Policy, credentials, human gates, Vault, confidentiality, and lifecycle preconditions still decide each effect, and a member gains neither another user's private scope nor deployment administration. The English wording is the primary agent's projection of the engineer's direction. Core permissions and the multi-user Workspace specification own the rule.

## Reason

Not recorded. The engineer gave the direction as part of an agent-native clarification of generative apps without stating why the ceiling was removed. Ask the engineer before changing this rule, and record the answer in a new record that supersedes this one.

Source: change record 202609081810390001-generative_kernel_ui_design, Intent Epoch 3.

## Rejected Alternatives

- The owner, editor, and viewer grant ceiling, per-app roles, and collection or field access lists. Superseded as design targets; no reason recorded.

## Revisit When

Not recorded. Finer permissions are expected to reuse the existing subject, action, resource, and context contracts.

## Affected Owners

- docs/core/permissions.md
- docs/specs/20260715-multi_user_workspace_system.md
