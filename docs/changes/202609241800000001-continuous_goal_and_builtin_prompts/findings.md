# Findings

These findings record independent owner and implementation observations for the continuous Goal change. They authorize no design amendment and do not replace its accepted specifications or the engineer's pending decisions.

## Follow-up Index

- [ ] `GOALCONT-FND-001` [open] Resolve planning-only admission against unimplemented autonomy fields
- [ ] `GOALCONT-FND-002` [open] Retain exact completed no-Review Task result references

## [open] GOALCONT-FND-001 — Resolve planning-only admission against unimplemented autonomy fields

- **Observation:** The Goal owner requires every Plan proposal to bind autonomyClass, budget and completionVerification, but the existing Goal row and creation path do not implement those fields. The new bounded planning-only Turn exposes only goal.plan.propose and cannot dispatch or complete work. Existing direct human Goal commands also predate those fields.
- **Impact:** A passing bounded planner cannot be declared owner-conforming while the broader admission requirement remains unresolved. Inventing default delegation policy or silently disabling existing human steps would change accepted scope and behavior.
- **Evidence:** Goal autonomy boundary and current Goal storage shape; independent Goal owner inspection and Grok Consultant scrutiny in temp/changes/202609241800000001-continuous_goal_and_builtin_prompts/grok-planning-authority-final-proposal.txt.
- **Owner:** This continuous Goal change's primary coordinates the concrete owner amendment; the engineer owns its approval under AGENTS.md AUTH-001.
- **Next action:** The primary prepared planning-authority-amendment-proposal.md in the same temporary bundle and asked the engineer to approve the narrow planning-only and existing-human-command exception while retaining the full autonomous-progression requirement. That decision remains pending; only dependent acceptance is paused.

## [open] GOALCONT-FND-002 — Retain exact completed no-Review Task result references

- **Observation:** The no-Review source snapshot treats every completed output on the predecessor Task's Worker Turn as accepted evidence. The exact terminal selected Item and Artifact IDs are written to WorkerCheckpoint diagnostics, but normal Goal step closeout clears that checkpoint after the receipt. Retained RuntimeEvidence has counts and a digest, while the current GoalTaskRecord has no exact terminal-result tuple.
- **Impact:** A successor can misrepresent an omitted same-Turn output as an accepted completed result. Retaining checkpoints would block later steps under their existing lifecycle, and failing every normal completed-result carry would break the requested continuous planning behavior.
- **Evidence:** Independent reviewer and builder traced goal-worker-outcome.ts, goal.step checkpoint cleanup and goal-source-evidence.ts. The independent regression in goal-continuous-planning.test.ts observes ar_unaccepted_same_turn_output in the source snapshot despite terminal diagnostics selecting only ar_completed_task_output; raw failure is temp/changes/202609241800000001-continuous_goal_and_builtin_prompts/no-review-accepted-ids-probe.txt.
- **Owner:** This continuous Goal change's primary; Goal Mode Coordination owns Task completion and source evidence, while the engineer approves any governing storage amendment.
- **Next action:** Pause the dependent source-evidence correction. An independent Grok Consultant is inspecting the smallest durable-owner amendment, including reuse of GoalTaskRecord rather than a new record family; prepare exact lifecycle, recovery and portability criteria before asking the engineer. No proposed field or new checkpoint lifecycle is approved. The Consultant recommended an immutable completedOutcome tuple on the existing GoalTaskRecord, written with no-Review completion and reminted on import; the concrete completed-outcome-owner-proposal.md was presented to the engineer and remains pending. The stronger no-review-postcleanup-probe.txt reproduces over-acceptance after actual checkpoint clearance (one failed test, 15 skipped); it is a boundary counterexample, not proof that the public collector routinely selects a subset.
