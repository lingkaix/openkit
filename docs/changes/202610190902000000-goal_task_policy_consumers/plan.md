---
type: change-plan
status: in-progress
---
# Goal Task Policy Consumers

## Intent Revision 1

The coordinator approved the remaining Goal-domain runtime consumers on 2026-10-19 at09:02Z. Existing joint Plan approval and native Policy publication remain their owners. This increment connects prepared ordinary Task admission and live, captured human-response and result readback effects to the existing Policy service. Coordinator administration follows only after L-CH supplies its reviewed bounded writer.

## Owners And Boundaries

[Goals](../../specs/20261002-goal.md), [Task Mode](../../specs/20260704-task_mode_worker_delegation.md) and [Policy Enforcement](../../specs/20260703-policy_enforcement_mapping.md#goal-domain-and-container-projection) own the accepted behavior. L-GO owns Task and runtime consumers and application composition. L-CH owns Policy/configuration/Protocol, delegated permission projection and administration persistence. No new retained field, record, store, evaluator or retry mechanism is introduced. Web and Knowledge source paths are outside this increment.

## Mechanism Necessity

- Prepared Task admission must call the existing Goal Task service before reservation because an approved Plan alone cannot authorize an unavailable domain or a Worker outside its envelope. Native current human admission remains mandatory.
- Live and captured effects must call the existing service with canonical Task and Worker facts because the human Kernel alone does not enforce the approved Goal and Task bounds. Descriptive references grant no rights.
- Existing authorization revisions and finite-use references must include current Goal and Task facts because closure, Plan replacement, revocation and exhaustion must stop later dispatch. Same-effect readback recognizes its own recorded atomic allow without spending another use or granting another call.
- Result delivery must recheck current authority because a settled upstream effect does not authorize disclosure after its Goal authority ends. The original effect and usage remain recorded truthfully.

## Execution And Evidence

Independent Test Author context `/root/goal_consumers_test_author` derives regressions from accepted owners before production edits. The first fixture run failed its healthy controls before the intended seam; it is setup evidence only, not RED. The author corrected only the missing retrieval binary linkage, concrete catalog defaults and a fixture SQL column name. These setup failures remain separate. Test commits c8b4833cf and 6a874d6a9 established two admission failures with one healthy control and four effect failures. Final test commit 5def43ceb added the real captured post-contact disclosure failure, with the actual successful Pending claim, effect and usage preserved. The builder then implemented those consumers without weakening the tests. Focused builder checks passed all fourteen tests across the new consumer file and the existing six-case Task fixture; Native typecheck also passed before the final readback correction. A separate fresh Sol reviewer, affected suites and final Native typecheck precede a normal current-main merge and direct-main landing. Full CI remains on main.

## Current Checkpoint

Current base is main `feac6fd01`, including the landed Source cutover and agent gate. The corrected L-CH interpretation is acknowledged: a current admitted delegated allow is an alternative association only in the existing goal-task class; the Goal-envelope association and human Kernel remain mandatory. No administration callable or complete Goal enforcement is claimed yet.
