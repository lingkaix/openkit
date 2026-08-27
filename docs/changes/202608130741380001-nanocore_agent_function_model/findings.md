# Findings

This report preserves out-of-scope observations and governance deviations discovered while executing the NanoCore Agent Function Model plan. A finding is not a decision: its accepted owner must settle it, and closed governance deviations remain historical evidence rather than retroactive authorization.

## Follow-up Index

- [ ] `F-1` [open] Accepted Task delegation still derives the worker Turn from the originating Chat Thread
- [ ] `F-2` [open] Accepted Goal coordination derives each worker Turn from the command's existing Thread
- [ ] `F-6` [open] WP-2 opened before WP-1 was verified

## [open] F-1 — Accepted Task delegation still derives the worker Turn from the originating Chat Thread

- **Observation:** `docs/specs/20260704-task_mode_worker_delegation.md:97` derives the downstream Task Turn from the outer Chat actor, Workspace, and Thread. WP-1 amended `docs/core/core-concepts.md:73` to require that a handoff always creates a new Thread in the Workspace that will own the receiving execution. Both are accepted and they contradict each other: one says the receiving execution continues in the originating Thread, while the other says it may not. The same specification at line 144 derives the Task state `cancelled` from the condition "the Turn is cancelled" even though WP-1 retired `cancelled` as a Turn terminal state, so that trigger now names nothing; the Task state itself is unaffected, because retiring a Turn state does not retire a Task state.
- **Impact:** An implementer reading only one accepted owner builds the wrong receiving execution and may pass review, while WP-8 otherwise implements Quick Chat handoff by picking a side in code, which `[AUTH-002]` forbids. The Task cancellation trigger must also be restated against a condition that still exists.
- **Evidence:** The WP-1 independent reviewer raised the finding on 2026-08-13. The cancellation trigger was recorded here because the correction round deliberately left `cancelled` alone where it terminalizes something other than a Turn; a search across `docs/core/` and `docs/specs/` found no other Turn-state occurrence outside the four taken by that round, and the remaining hits concern `CapabilityCall`, steering-delivery state, or retired and superseded documents.
- **Owner:** WP-4. The task-delegation specification was in no package artifact inventory when the finding was raised, which was itself a lease defect, so WP-4's inventory is amended to carry it.
- **Next action:** Either amend the specification to create and reference a receiving Thread or narrow the Core rule to identify which handoffs require one; leaving both accepted is not a disposition. In the same owner correction, restate the Task cancellation trigger without reintroducing `cancelled` as a Turn terminal state.

## [open] F-2 — Accepted Goal coordination derives each worker Turn from the command's existing Thread

- **Observation:** `docs/specs/20260704-goal_mode_coordination.md:243` derives each Goal-step worker Turn from the command's existing Workspace and Thread. WP-1 amended `docs/core/runtime-model.md:152` to require every concurrently scheduled Goal worker execution to receive its own Thread and AgentSession, with the Goal Main Thread retaining a reference Item. The Goal specification has no vocabulary for an execution Thread or parent-reference lineage, so the Core statement is not merely contradicted but inexpressible in the document that must project it.
- **Impact:** WP-11 otherwise implements Goal progression with no accepted definition of the Thread used by each worker execution, and the reference Item has no owner.
- **Evidence:** The WP-1 independent reviewer raised the finding on 2026-08-13 from the two accepted owner locations named in Observation.
- **Owner:** WP-4, within its existing lease.
- **Next action:** Reconcile the Goal coordination specification with the accepted per-worker execution Thread and AgentSession rule, including the Goal Main Thread reference Item and its lineage, before WP-11 relies on it.

## [closed] F-3 — An ephemeral Thread selects a retention class that was defined for something else

- **Observation:** WP-1 amended `docs/core/core-concepts.md:71` so an ephemeral Thread selected the shortest existing Core retention class. `docs/core/storage.md:88`–`96` made that class `ephemeral-diagnostic`, while `docs/specs/20260703-audit_usage_evidence_records.md:284` defined it for short-lived health checks, retries, and feature negotiation rather than conversation Threads carrying user content. Choosing the shortest existing class avoided inventing a class but reused a name whose policy meant something else.
- **Impact:** Without correction, ordinary conversation content would be retained under a policy written for health checks, making a data-retention decision by accident. WP-6's predicate also forbade Agent data from introducing new retention vocabulary, so failure to find a genuinely applicable class had to escalate instead of being hidden by a new one.
- **Evidence:** The WP-1 independent reviewer raised the finding on 2026-08-13. The WP-6 builder stopped with zero edits after enumerating every existing Core class: `ephemeral-diagnostic` covers health checks, retries, and feature negotiation; `turn-evidence` explains worker Turns and verification; `workspace-audit` covers governance records; `restricted-raw` covers sensitive raw diagnostics; and `legal-hold` is an exceptional deletion block. The finite enumeration proved that none covered ordinary conversation content and crossed the `[AUTH-002]` boundary because the required Core correction lay outside the WP-6 lease.
- **Owner:** The engineer settled the Core classification through the WP-6 escalation; the Core Thread owner carries the accepted result.
- **Next action:** Transition history: the available dispositions were to remove the `ephemeral` classification, explicitly widen `ephemeral-diagnostic`, or accept a new Thread-applicable class. The engineer selected removal; no follow-up action remains under this finding.
- **Closing verdict:** Closed by the engineer's 2026-08-13 decision to remove the unsupported classification rather than invent or widen a retention policy without a present need.
- **Closure evidence:** `ephemeral` was deleted from `Thread` in `docs/core/core-concepts.md`, while `threadSource` and `parentThreadId` remained because they carry handoff lineage and the conversational-versus-worker-execution distinction. The classification existed only in WP-1's then-uncommitted change, so no accepted document or running code depended on it; `[QUALITY-003]` supports adding a future short-retention Thread class only when a present need has an appropriate owner, and the retained enumeration records why it must not simply reuse `ephemeral-diagnostic`.

## [closed] F-4 — WP-0 was built by the primary agent

- **Observation:** `[ORCH-001]` admitted the primary agent as a producer only for non-authoritative coordination prose, but WP-0 deleted a change record holding an unmet predicate and repointed four cross-record references. That was production work on a governed artifact and should have been dispatched to a registered `builder`.
- **Impact:** The producer assignment violated the program's governance boundary even though it did not falsify the resulting artifact.
- **Evidence:** Two later independent plan-review passes reached exactly WP-0's stated scope, and the state file therefore recorded its gate as `PASS`.
- **Owner:** Not recorded.
- **Next action:** Historical correction: governed-artifact production of this kind must be dispatched to a registered builder. The landed mechanical retirement was recorded rather than repeated because replaying it would prove less than the completed independent review.
- **Closing verdict:** Closed as a recorded producer-role deviation; the work itself was independently adjudicated and has no remaining correction.
- **Closure evidence:** The two independent review passes accepted the exact WP-0 artifact scope, distinguishing the unauthorized producer assignment from artifact correctness.

## [closed] F-5 — The orchestrator re-rated the plan reviewer's severities

- **Observation:** The plan-freeze coherence pass returned twelve of twenty findings marked BLOCKING and double-reported two defects. The orchestrator re-rated them to one blocking, six material, four minor, and three rejected, and the repair work followed that re-rating.
- **Impact:** `[ORCH-004]` says the orchestrator adjudicates nothing. Reclassifying a reviewer's BLOCKING verdict as MINOR was adjudication and changed which findings were corrected.
- **Evidence:** The original twenty-finding report and the recorded one-blocking, six-material, four-minor, and three-rejected disposition preserve the exact severity change and duplicate handling.
- **Owner:** Not recorded.
- **Next action:** Future inflated or internally inconsistent review results go to a second adjudicator instead of being corrected by the orchestrator. No historical repair remains under this item.
- **Closing verdict:** Closed as a recorded governance deviation without retroactive authorization; the record makes clear that the program triaged the findings through an authority the orchestrator did not hold.
- **Closure evidence:** The plan's 2026-08-13 freeze checkpoint records the review findings, the subsequent corrections, and the deviation rather than presenting the primary agent's re-rating as independent acceptance; root `[GOV-017]` now also forbids a producer report from accepting its own artifact.

## [open] F-6 — WP-2 opened before WP-1 was verified

- **Observation:** WP-2's dependency was "WP-1 verified", but its builder was dispatched while the WP-1 correction round remained open because the leases were disjoint and WP-2 was believed to depend only on WP-1's amendments to `docs/core/core-concepts.md`, which the correction round would not touch. WP-4, WP-5, and WP-6 were opened on the same reasoning. WP-5 was also Tier 4, so its direct human scrutiny and different-family reviewer gates were owed and then unmet.
- **Impact:** The written dependency was not satisfied, and treating a disjoint lease as equivalent to verified dependency relied on the orchestrator's judgement about its own plan. Any WP-2 output resting on a later-changed WP-1 statement must be traced through this deviation.
- **Evidence:** The 2026-08-13 checkpoint explicitly records that WP-2 opened while WP-1 was unverified. WP-5 was Tier 4, and its builder stated that direct human scrutiny and a different-family reviewer were still owed and declined to self-adjudicate. The adaptive-loop cutover later retired the fixed queue, exact lease sequence, and package gates as historical dispatch authority, but the current checkpoint says the WP-1 through WP-6 artifact claims remain unverified.
- **Owner:** The current plan's primary agent owns artifact reconciliation; the engineer and a different-family verifier own WP-5's retained Tier-4 gates.
- **Next action:** Follow the plan's current checkpoint by inspecting the actual WP-1 artifact and diff, then trace WP-2 and the remaining WP-1 through WP-6 artifacts against their accepted owners without replaying the former queue. This item closes only after that reconciliation either proves the dependent artifacts and retained Tier-4 gates or records a narrower unresolved finding.

## [closed] F-7 — A dispatch made one blocked decision stop five unblocked ones

- **Observation:** The first WP-6 dispatch told the builder to stop and escalate if no existing retention class applied to ephemeral Threads but did not scope that stop. The builder therefore correctly halted the whole package, leaving the unrelated warm-reuse rewrite, AgentSession-static layout, materialization and synchronization decisions, source-boundary decisions, and four shared-working-material constraints unabsorbed behind one independent question.
- **Impact:** An absorption package containing independent decisions can turn one legitimate stop condition into a package-wide block when dispatch does not identify the affected slice. The same dispatch-sufficiency premise had already failed in WP-2, whose request for Core-to-spec pointers conflicted with the documentation validator and required unprompted builder adaptation.
- **Evidence:** The repair re-dispatched WP-6 with the blocked retention decision explicitly carved out, leaving the other five decisions able to proceed without weakening the stop. The WP-2 tooling conflict supplies the earlier instance of the shared cause: dispatch was written from the plan without checking the tooling and internal package structure.
- **Owner:** Not recorded.
- **Next action:** Scope future stop conditions to the decision they govern when sibling decisions are independent. No further work remains because the re-dispatch already isolated the blocked decision.
- **Closing verdict:** Closed by the corrected WP-6 re-dispatch, which preserved the authority stop while releasing the five unrelated decisions.
- **Closure evidence:** The corrected dispatch named and carved out the retention-class decision rather than relaxing it, allowing the independent remainder to continue.

## [closed] F-8 — Program state cannot substantiate its own execution history

- **Observation:** The builder for the 2026-08-20 stalled-plan reconciliation found `temp/state/202608130741380001-nanocore_agent_function_model.state.json` at revision 9 with 75 events. Its first `status_changed` event said revision 1 was written retroactively after the first two packages ran and that timestamps were reconstructed; it recorded 18 opened and 18 closed assignments but only four gates, so most closures had no state-recorded entry or exit verdict and no verifier assignment existed.
- **Impact:** At the time, this conflicted with the Program State And Orchestrator Ownership contract then stated in `docs/change-execution.md`, which required contemporaneous event sequence, atomic monotonic writes, gate evidence, and verifier reconciliation while Git remained authoritative. Structural validity could not recover contemporaneity or missing evidence.
- **Evidence:** The historical file's own revision-1 event disclosed reconstruction, and its assignment and gate counts demonstrated the missing evidence. At the adaptive-loop cutover the file was absent, so the plan explicitly rejected appending or reconstructing it and retained Git and actual artifacts as current implementation fact.
- **Owner:** Not recorded.
- **Next action:** Historical disposition: leave the old file unchanged, treat absent gates and verifier assignments as absent evidence, never backfill or renumber events, and require the pre-close verifier to reconcile it against Git and the final plan. Future programs that need state create it before the first package and append through the existing atomic-write rule. The adaptive-loop cutover found the file absent, so current work follows the artifact-first checkpoint and does not reconstruct it.
- **Closing verdict:** Closed as a historical evidence-quality finding because the adaptive-loop cutover rejects the legacy state as current proof and supplies an artifact-first continuation route; closure does not claim that the missing historical evidence was recovered.
- **Closure evidence:** The plan's Current checkpoint states that the legacy state file is absent at cutover, is not current evidence, and must not be appended or reconstructed; it directs a fresh context to inspect the actual WP-1 artifact and diff against accepted owners.
