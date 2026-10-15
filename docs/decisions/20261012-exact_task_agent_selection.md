---
status: Accepted
date: "2026-10-12"
decider: Engineer
---
# Exact Task Agent Selection

## Decision

`task.start` accepts optional exact `agentId`. When supplied, it restricts eligible candidates to that Agent. The Coordinator never substitutes another Agent. If it is not eligible and ready, Task admission refuses with `409 task_mode_not_delegated` before effects. The selector enters the replay hash only when supplied, so omitted selectors retain existing replay identity.

## Reason

The engineer accepted this projection in [#133, comment 6117121388](https://github.com/lingkaix/openkit/issues/133#issuecomment-6117121388), verified directly on 2026-10-15. Naming an Agent in prompt text did not control deterministic candidate selection. An exact structured selector makes that user choice enforceable without changing ordinary selection.

The accepted placement was after RC4 with both owners and code aligned. The later rc.8 P11 dispatch requests early owner-supplier commits for P07/P12. This record makes no implementation claim.

## Rejected Alternatives

- Silently substituting another ready Agent contradicts an exact user selection.
- Adding an omitted selector to the replay hash changes existing command identity without a supplied choice.
- Interpreting a prompt name as exact selection leaves the choice ambiguous and duplicates structured admission.

## Revisit When

Revisit when an accepted Task contract requires a different explicit selection policy. Existing eligibility, readiness, authorization, and replay owners remain binding.

## Affected Owners

- [Task Mode Worker Delegation](../specs/20260704-task_mode_worker_delegation.md)
- [Workflow Coordinator](../specs/20260704-workflow_coordinator_internal_agent.md)
