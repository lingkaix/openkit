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

[Goal Mode Coordination](../../specs/superseded/20260704-goal_mode_coordination.md) owns Goal intent, immutable Plans, approval, Task admission, replay and recovery. Workflow Coordinator Internal Agent owns the semantic Orchestrator and deterministic Coordinator boundary. Internal Agent Runtime owns fixed prompt assembly. Their rules land before dependent implementation. The existing Work Model, App API, Worker Turn and storage owners continue to govern identity, authorization, execution and retention.

Named seams are user commands through Goal persistence and exact Plan approval to Worker admission; model Tool calls through the bounded internal loop to those same Goal owners; and centralized fixed role text plus dynamic context through provider assembly. A separate test author derives behavioral checks across these seams. An independent reviewer inspects the actual final diff, including criterion preservation in owner amendments.

## Working Checkpoint

On 2026-09-28 the engineer froze further Goal Mode development pending complete product Redesign. Checkpoint cba4e11a preserves the current implementation, including the known no-Review source-evidence regression. Both pending governing proposals are deferred to that Redesign; neither is approved, and this pause is not technical acceptance. Do not continue Goal storage, execution, or associated export changes under the earlier next action. Configuration and previously completed export checks remain historical results, not proof of the future export design. Built-in prompt centralization is not rescinded by this Goal freeze.

Next action: preserve current artifacts and evidence; resume Goal work only when the engineer activates Redesign. Workspace export now targets external use, with no lossless re-import requirement; backup / restore awaits a separate design. No new backend or data migration is authorized. The remaining out-of-scope findings and queued tasks retain their existing boundaries.

## Handoff And Evaluation

Full-body portable export and tolerant configuration are complete under their own plans and commits, 5d931915 and 2b64298a respectively. The remaining Goal retention finding is deferred by the engineer freeze; do not implement it for closeout. Non-Goal prompt and retention follow-up transfers to [the receiving handoff](../202609290900000001-chat_task_stability_handoff/plan.md). Documentation normalization and separate framework experiments remain queued under the handoff. Record direct evaluation of the completed work with exact checks and raw complexity observations, not scores or claims of framework causality. Update the Chinese working note under temp/quality-governance/ with how the engineering principles affected actual decisions and their limits.

## Intent Revision — 2026-09-28

The engineer freezes Goal Mode development and defers both pending decisions, storage, flows, and related export structures to complete product Redesign. Export is for external analysis and audit, not lossless re-import; backup / restore will be designed separately. Candidate storage directions do not authorize implementation. See [the recorded decision](../../decisions/20260928-goal_freeze_and_export_backup_boundary.md). This revision supersedes earlier instructions to continue the frozen work until complete.

## Non-Goal Prompt Check — 2026-09-29

The existing builtin-prompts.test.ts guard passes two tests on the integrated-work preparation checkout, covering all three fixed prompt texts and the 3000-code-point bound. Raw output is temp/changes/202609290900000001-chat_task_stability_handoff/builtin-prompts.txt. This is count/source evidence, not final acceptance of Goal behavior or live model quality.
