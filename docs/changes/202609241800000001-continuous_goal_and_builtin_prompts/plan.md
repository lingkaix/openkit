---
type: change-plan
status: in-progress
date: "2026-09-24"
---
# Continuous Goal And Built-In Prompts

## Intent Revision 1 — 2026-09-24

The engineer approved recording the Goal discussion, amending its specifications, implementing the design, and expressing it clearly in the Orchestrator System Prompt. Planning is continuous within one Goal. Users may refine or change intent during progress. Initial Plans and material revisions require approval; authorized execution refinements do not require a repeated gate. User-approved intent does not authorize every consequential implementation choice. Stop and revocation take effect immediately, affected work pauses, and unaffected valid work may continue under its approved authority. Running Turns retain their admitted context. No separate Planning workflow is requested.

The engineer also requested centralized fixed System Prompt text for every NanoCore built-in agent, informed by Pi's fixed preamble and dynamic assembly. The fixed portion is limited to 3000 characters with an executable test. Unicode code points, including shared fixed text and whitespace, define the count; dynamic Tool contracts and current context remain separate. All earlier handoff active tasks remain required. The engineer requested a checkpoint commit before further edits; commit 73f8ff22 fulfilled that instruction. Local commits are authorized, but push, deployment, external publication, and temporary-file deletion are not.

## Owners And Seams

[Goal Mode Coordination](../../specs/20260704-goal_mode_coordination.md) owns Goal intent, immutable Plans, approval, Task admission, replay and recovery. Workflow Coordinator Internal Agent owns the semantic Orchestrator and deterministic Coordinator boundary. Internal Agent Runtime owns fixed prompt assembly. Their rules land before dependent implementation. The existing Work Model, App API, Worker Turn and storage owners continue to govern identity, authorization, execution and retention.

Named seams are user commands through Goal persistence and exact Plan approval to Worker admission; model Tool calls through the bounded internal loop to those same Goal owners; and centralized fixed role text plus dynamic context through provider assembly. A separate test author derives behavioral checks across these seams. An independent reviewer inspects the actual final diff, including criterion preservation in owner amendments.

## Working Checkpoint

The working implementation now uses one bounded Goal Orchestrator proposal path for initial and ongoing planning, existing human question gates, same-Goal intent revisions, distinct active and pending Plans, historical approved Task rows, ordered unfinished-Task dispositions and exact stale-approval checks. Web exposes proposal context, affected-work selection and explicit retry/redraft/continuation. Three built-in fixed prompt assemblies share one bounded text source; Tool schemas and current structured context remain dynamic. Focused Web tests pass 79 cases, Core Client 81 and App API schemas 148; these counts precede final backend integration and are not final acceptance.

Independent checks found and corrected concrete lineage, replay, question-input, stale-candidate and UI faults. The broad Goal and prompt set passed 160 tests across 18 files, and the refinement regression proves its Item precedes worker launch and exact replay creates no duplicate. A later independent regression exposed a remaining no-Review result-authority defect: selected terminal evidence IDs are lost when the checkpoint is cleared, and the source reader overclaims other outputs from that Turn. The deciding red is retained in the temporary bundle; it supersedes any completion claim based only on the earlier green set. [Findings](findings.md) records that gap and the separate pending authority decision. A pending governing issue is explicit: Goal's historical full autonomous-progression contract requires delegation fields absent from the current Goal row. Independent Grok Consultant scrutiny recommends a planning-only and existing-human-command carve-out, preserving the full eight-Tool progression requirement. The concrete amendment is in temp/changes/202609241800000001-continuous_goal_and_builtin_prompts/planning-authority-amendment-proposal.md and awaits the engineer. Until that ruling the Goal slice cannot be called owner-conforming or accepted; unrelated tests, correction and handoff tasks continue.

The no-Review regression now composes normal checkpoint cleanup and still fails. Its typecheck and formatting pass, so setup failure is not its cause. The concrete completed-outcome-owner-proposal.md reuses GoalTaskRecord and awaits a separate engineer ruling. The repository check passes with three warnings and 18 informational diagnostics (repo-predecision.txt), but that static result does not settle the behavior or governing findings.

Predicted Next Action: obtain the two engineer rulings, implement only the accepted owner amendments and source-evidence correction, then rerun the deciding regressions and obtain final independent implementation review. Expected observable: exact request and intent lineage, preserved failed-attempt capture, safe Plan activation and inspectable refinements with no separate PlanningSession or additional execution authority. A new behavior counterexample reopens only its affected seam; unresolved authority pauses its dependent acceptance.

## Handoff And Evaluation

Full-body portable export and tolerant configuration are complete under their own plans and commits, 5d931915 and 2b64298a respectively. Close the remaining retention findings with the independently verified Goal failure/readback correction. Documentation normalization and separate framework experiments remain queued under the handoff. Record direct evaluation of the completed work with exact checks and raw complexity observations, not scores or claims of framework causality. Update the Chinese working note under temp/quality-governance/ with how the engineering principles affected actual decisions and their limits.
