---
type: change-plan
status: in-progress
date: "2026-09-24"
---
# Governance Landing Handoff

## Intent Revision 1 — 2026-09-24

The engineer asked for a handoff instruction so that another worker carries out all the work that remains after the engineering governance landing, in order. The work includes making hand-written configuration report unknown keys as warnings instead of errors. Specification normalization and the evaluation of the new governance framework come after the handoff work: they are listed here in order, but the worker does not start them until the engineer says so. Runtime compatibility and verification, including DeepSeek Harness, are only recorded and wait for a later decision. The temp inventory stays as it is for the engineer to handle later. This handoff authorizes the work of the active tasks under each task's own plan; it authorizes no push, deployment, external publication, or deletion of temporary material. Commits follow CONTRIBUTING.md under the local Git identity with no agent attribution trailers.

## Before You Start

- Read root AGENTS.md, then docs/change-execution.md, then docs/roles/README.md. You are the primary of this handoff; choose delegates by the presets in docs/change-execution.md and dispatch them with the prompt template in docs/agent-harnesses.md. A delegate reads root AGENTS.md and then its role file.
- Read [Engineering Governance Landing](../202609231611190001-engineering_governance_landing/plan.md) and its [proposal](../202609231611190001-engineering_governance_landing/proposal.md), which map every landed decision to its owner. Decisions and their reasons are under docs/decisions/; link a decision record beside any rule you change and record any new engineer ruling as a new record.
- Check the Node version in any Herdr pane before trusting a failing SQLite suite; panes may miss the mise toolchain.
- The repository check (check:repo) currently stops at biome on 15 errors in 14 apps/nanocore files from the paused runtime child retention work; task 1 removes them.

## Active Tasks, In Order

1. Resume runtime child retention. Plan: [runtime child retention](../202609220200000001-runtime_child_retention/plan.md), paused by the engineer on 2026-09-23 and committed as work in progress. Start with its [findings](../202609220200000001-runtime_child_retention/findings.md): RCR-FND-004 first (reconcile with the governance landing, including roles under docs/roles/, L2 composition tests, Intent Revision naming, decision-record links, and the biome errors in its 14 files), then RCR-FND-001 to RCR-FND-003. Done when that plan's own acceptance holds and the repository check passes its biome step.
2. Complete work data export. Plan: [complete work data export](../202609241200000004-complete_work_data_export/plan.md). Restricted original bodies travel intact in a portable export and are restored intact on import. Begin with the round-trip regression its checkpoint names, written by a test author separate from the builder. Done when that regression and the existing export and import suites pass.
3. Configuration tolerant reader. Plan: [configuration tolerant reader](../202609241200000001-configuration_tolerant_reader/plan.md). Hand-written configuration reports an unknown key as a warning and otherwise ignores it, while an unknown key in an authority-bearing section and a declared required feature still fail closed. First amend docs/specs/20260628-nanocore_config_identity_contract.md, which still says all authored files use strict schemas, with a Consultant check of the section classification; then change the loaders. Done when the plan's regressions pass and GOVLAND-FND-008 in the landing findings is closed.

Each task keeps its own plan, checkpoint, findings, and independent review, and closes with the numbers change execution asks for at closeout. Commit each task separately once its checks pass.

## Queued, Do Not Start

These wait until the engineer says to start them after the active tasks.

4. Documentation normalization. Plan: [documentation normalization](../202609241200000002-documentation_normalization/plan.md), GOVLAND-FND-009.
5. Governance framework evaluation. Plan: [governance framework evaluation](../202609241200000003-governance_framework_evaluation/plan.md), GOVLAND-FND-010.

## Recorded Only

These are recorded and have no task now.

- Runtime compatibility and verification: DeepSeek Harness dispatch and model binding (GOVLAND-FND-011), and a first observed dispatch per harness under docs/agent-harnesses.md before any route is marked verified.
- Platform references as a six-file enumeration versus a directory (GOVLAND-FND-012).
- Goal Mode candidate inputs GOVLAND-FND-001 to GOVLAND-FND-004, which wait for their owner.
- The temp inventory in temp/quality-governance/temp-triage.md, which the engineer handles; delete nothing under temp/.

## Working Checkpoint

Status is active on task 1. RCR-FND-004 is reconciled and the repository check passed its Biome step. Predicted Next Action: finish the independently reproduced retention corrections under task 1, including engineer-approved collector-fault semantics. Goal failure/readback work is paused while the engineer discusses the Planning phase; the other active tasks have not started. Expected observable: focused behavior checks and independent acceptance support task 1 closeout without weakening existing assertions. Evidence that changes the route: an unresolved governing decision, unexplained regression, or reviewer counterexample; preserve it in the owning task rather than declaring completion.

## Intent Revision 2 — 2026-09-24

The engineer transferred this handoff to the resumed runtime-retention primary, named the paused implementation and governance landing commits, and authorized completing its tasks in order followed by evaluation under the landed framework. The engineer specified gpt-6-sol for internal sub-agents and allowed independent Claude Code opus 5.5 consultation. The queued documentation-normalization task and recorded-only runtime qualification work are not activated by this instruction. Evaluation of the completed active work will distinguish direct observations from claims requiring the separately controlled framework experiments.
