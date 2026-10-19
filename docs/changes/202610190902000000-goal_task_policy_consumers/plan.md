---
type: change-plan
status: implemented
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

Items 1–3 are implemented for ordinary Goal-linked Task admission and the MCP interception pilot. Main `157818cd6` was normally merged into `935f9e029`, including the separately reviewed Policy writer and product classification. A current delegated allow is an alternative association only in the existing goal-task class; the Goal-envelope association and human Kernel remain mandatory. This increment retains the plain Kernel callback. Coordinator escalation routing and administration consumption require the separate canonical Tool-input join and remain unfinished; no complete Goal enforcement is claimed.

## Independent Review Correction

The fresh reviewer identified one reachable continuation defect: the Policy subject correctly retained the original Goal accountable human, but a later administrator-triggered Turn supplied that administrator to the captured request. Independent test-author commit `92cf2961a` reproduced the real response failure before claim and added successful execution, actual administrator credential and Audit attribution, and canonical reload checks. A producer-only correction then exposed the same incorrect trigger/accountability equivalence in canonical Pending loading. The correction uses the canonical Task human for the native capture and preserves exact Worker, Session and captured source checks at historical load. The actual trigger and deciding actor remain separate. The retained record shape and strict Policy-source equality are unchanged; historical load needs no live Goal or new authority record.

## Final Local Qualification

The first affected runtime run passed 142 cases and timed out in the unchanged Goal Coordinator Knowledge case at its existing 30-second budget. The retained `goal-consumers-final-affected.log` then passed 251 of 252 cases across sixteen complete files, including all three Goal Coordinator cases. Its one assertion failure showed that a shared currentness catch changed a Policy dependency error into a stale outcome. Correction `f478a42cf` preserves exceptions during common Policy evaluation and catches unavailable authority only at settled live result delivery, where content must be withheld without rewriting the effect. The existing I16 assertion and all nine Goal cases passed in the focused check.

The complete correction check passed fifty of fifty-one cases; the unchanged credential-before-claim case timed out once at its existing 30-second budget. No test, assertion or timeout changed. The clean current-main overlap in `goal-consumers-classification-overlap.log` then passed all 233 cases in twenty complete files: the full Policy directory, Worker MCP routes, captured Pending calls and the new Goal consumers. That credential case passed in 8.854 seconds. The same terminal command passed Native build and typecheck, canonical OpenAPI and CLI generation with unchanged generated bytes, repository checks and the whitespace check. Repository checks retained two warnings and twenty-five information diagnostics, with no fixes applied. Other passing Goal, Task, Pending and Tool-inventory suites remain recorded in the original affected log; no whole NanoCore suite is claimed.

The same fresh reviewer inspects the source correction, clean main merge and terminal evidence in `reviews/L-GO-goal-task-consumers-review.md`. Initial setup failures and every failed execution remain distinct from accepted RED and final passing evidence. Real vendor behavior, deployment, the rc.11 onboarding loop and the unfinished Coordinator Tool join are outside this local acceptance.
