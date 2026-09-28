---
type: change-plan
status: planned
date: "2026-09-24"
---
# Governance Framework Evaluation

## Intent Revision 1 — 2026-09-24

On 2026-09-24 the engineer asked for several concentrated maintenance rounds after the governance revision to judge whether the new framework is better, at least through code review. [Engineering Governance Landing](../202609231611190001-engineering_governance_landing/plan.md) landed the framework, including maintenance rounds, the removal evidence outcomes, the rebuild and discovery probes, and closeout complexity numbers, and drafted this plan. The outcome is evidence, from raw before and after observations against predictions registered in advance, on whether work done under the new framework is simpler, as correct, and cheaper to review than comparable work under the previous framework, and several maintenance rounds completed under the new rules, as the engineer requested; the first round is the first tranche, and the engineer decides after each round whether another is needed. The engineer transfers this plan to a primary before work starts and decides what the evidence means for the framework. Behavior changes are out of scope. No commit, push, deployment, or external publication is authorized by this draft.

## Owners

[Change Execution](../../change-execution.md) owns maintenance rounds and closeout numbers. [Verification Calibration](../../specs/20260719-verification_calibration.md) owns removal evidence, the rebuild probe, and the discovery probe. [Verification Instruments](../../verification-instruments.md) owns oracle quality. The role contracts under [docs/roles/](../../roles/README.md) own reviewer and auditor practice.

## Accepted Decisions

- [Concentrated Maintenance Rounds Complement Everyday Design Upkeep](../../decisions/20260924-periodic_maintenance_rounds.md).
- [System Complexity Is Governed At Design Time And Observed As Trends](../../decisions/20260923-system_complexity_signals.md).
- [Review Uses Executable Counterexamples And Raw Observations, Not Scores](../../decisions/20260923-review_questions_without_scores.md).

## Working Checkpoint

Status is planned. Two cleanup batches ran on 2026-09-22 under the previous framework and are verified in docs/changes/202609220000000001-engineering_quality_pilot/ and docs/changes/202609220100000001-engineering_quality_batch2/; their baselines and patches are the comparison material. No rebuild probe has run, and no discovery probe has run under the new framework; the pilot's earlier discovery comparison is recorded in its change record and is the baseline for one. Scores and line-count targets are excluded by the accepted decisions, so comparisons use raw observations.

Method, to be revised by evidence:

- Replay: in separate worktrees at the same baseline commit, give one bounded task to a primary under the previous governance text and to a primary under the new text, with the same model and version, reasoning settings, tools, permissions, task statement, and starting artifacts, recording any difference that cannot be avoided as a limitation, and have an independent reviewer who does not know which is which review both diffs for correctness, simplicity, caller obligations, and consumer closure.
- Seeded defects: plant a small set of known defects at representation seams before the replay, and record which review finds them.
- Maintenance rounds: run rounds under the new rules, starting with one, with hypotheses and expected observables registered before editing, characterization tests before untested code, removal outcomes for each deletion candidate, and an Auditor evaluation from raw before and after observations.
- Probes: one rebuild probe on a small concept and one unhinted discovery probe, each recorded with model, tool, and context differences.

Predicted Next Action: register the replay task, the seeded defects, and the predictions in the plan before any worktree is created. Expected observable: a registered prediction per comparison question. Evidence that would change the route: a replay whose two runs differ in something other than the governance text, which invalidates that comparison.

## Verification Direction

The reviewer of each replay is independent of both producers and blind to which framework produced which diff. The Auditor compares registered predictions with results and reports later regressions attributable to the maintenance round. The engineer receives the raw observations and the Auditor's reading, and decides.
