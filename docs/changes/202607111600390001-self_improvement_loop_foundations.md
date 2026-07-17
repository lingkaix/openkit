# Self-Improvement Loop Foundations

Type: change-plan
Status: planned

## Intent

Implement the OpenKit self-improvement and evaluation loop defined by `docs/specs/20260710-self_improvement_evaluation_loop.md`, together with the prerequisite mechanisms specified for it on 2026-07-11: durable recurring/event triggers, Skill Catalog versioning and pinning, the Evaluation Harness runtime, knowledge provisional auto-promotion, context package replay reconstruction, the `improvement_proposal` Action Center row kind, and the evaluation/skill-catalog export families.

The end state: every workspace has a Reflector that mines its real work history, a frozen Harness that replays proposals against pinned suites in isolated sandboxes, a blind Judge, and human promotion gates — with all triggers, versions, budgets, evidence, and rollbacks running on durable governed records.

## Inherited Audit Responsibility (2026-07-17)

This plan is work package WP-6 of the [OpenKit Execution Program](./202607172152230001-openkit_execution_program.md) and absorbs audit group G07 from the [alignment audit](./202607111941330001-core_spec_implementation_alignment_audit.md). The G07 document set (C12 Knowledge, S17-S19, S60, S61, and their supporting projections) and the G07 exit criteria in the audit ledger are inherited inputs. The program's convergence rules bind all work here. G07 audits Knowledge selection into the accepted G01-owned Context Package interface without reopening workflow delivery, and this package activates only after real dogfooding work history exists to mine (program queue entry gate).

Before implementation starts, record the G07 audit preamble in this plan per Execution Program rule 11: the authority map for the concepts this plan touches, findings classified with the audit's finding codes (in-scope findings fold into this plan's frozen scope; everything else is ticketed to the program Backlog), and confirmation of the inherited exit criteria. The preamble is review-only, bounded to at most one review day, and authorizes no implementation.

## Scope

Specs to implement (design authority; this record does not restate their contracts):

- `docs/specs/20260710-self_improvement_evaluation_loop.md` — the loop model: Reflector, Harness contract, Judge convention, evaluation assets, `ImprovementProposal` lifecycle, tiers, trigger model, and Goodhart guards. This change plan owns implementation stage order.
- `docs/specs/20260711-scheduler_recurring_event_triggers.md` (new) — durable schedule/fire records, minute tick loop, coalescing catch-up, one-shot event-trigger convention, automation-store replacement.
- `docs/specs/20260711-skill_catalog_versioning_pinning.md` (new) — content-addressed skill version identity (`skv1` digest), catalog entry/version/pin records, pointer-move promotion and rollback, AEP digest resolution, replacement of the hardcoded `WORKER_SKILL_CATALOG`.
- `docs/specs/20260711-evaluation_harness_design.md` (new) — evaluation area layout, work/judge two-sandbox profile with a held-back acceptance zone, harness versioning and environment pinning, Judge dispatch with blinding and A/A injection, evidence assembly.
- `docs/specs/20260702-knowledge_store_governance_rules.md` (updated) — Provisional Auto-Promotion: strictly additive diffs, designated types, conflict-detection gating, `provisional` review state with TTL and citation confirmation, one-step rollback.
- `docs/specs/20260703-worker_context_package.md` (updated) — Replay Reconstruction contract: frozen per-entry reconstruction from recorded revisions and digests with typed per-entry failures.
- `docs/specs/20260531-human_attention_intervention_model.md` (updated) — `improvement_proposal` row kind with evidence-bundle requirement and batch-separation rule.
- `docs/specs/20260704-workspace_backup_export_import.md` (updated) — evaluation area and workspace-scope Skill Catalog families in export scope with coverage-guard wiring.

Impacted surfaces: `packages/protocol` (if new record envelopes are needed), `packages/app-api-schemas`, `packages/core-client`, `apps/nanocore` (scheduler services, agent-environment/AEP resolution, knowledge governance, internal agents, evaluation module family, action center, export/import, metering/usage categories, audit categories), the transport-neutral end-user operation catalog and bundled CLI when new public user/operator operations are exposed, and L0-L6 test assets including new L6 stories. `apps/web` reflects new read models only after kernel contracts stabilize, per the NanoCore-first and Agent-Skill-first operating model.

## Non-Goals

- No unattended recursive self-improvement: every behavior-changing promotion keeps its mechanical gate plus human approval gate, restating the owning spec's non-goal as a plan invariant.
- No universal benchmark, no cross-model ranking, no evaluation or automated mutation of NanoCore code itself.
- No second evaluation agent, no evaluation executor bypassing the durable scheduler, no sub-minute scheduling.
- No semver or dependency resolution for skills; no public skill registry or marketplace.
- No metering enforcement redesign beyond adding the self-improvement consumption category and honoring the trigger mechanism's budget deferral; full budget enforcement remains its own deferred work.
- No backward-compatibility layers for replaced internals (in-memory automation store, hardcoded skill catalog), per the repository compatibility rule.

## Related Context

- [Architecture](../core/architecture.md) — Task Evaluator placeholder resolution (Reflector + Harness + Judge) is promoted into the internal role table during this change.
- [Work Model](../core/work-model.md)
- [Product Vision](../product-vision.md)
- [Agent Workflow](../core/agent-workflow.md)
- [Knowledge](../core/knowledge.md)
- [Sandbox](../core/sandbox.md)
- [Audit](../core/audit.md)
- [Metering](../core/metering.md)
- [Agent Supply](../core/agent-supply.md)
- Specs listed under Scope, plus supporting contracts: [Durable Scheduler Design](../specs/20260703-durable_scheduler_design.md), [Audit Usage Evidence Records](../specs/20260703-audit_usage_evidence_records.md), [Knowledge Manager Internal Agent Runtime](../specs/20260704-knowledge_manager_internal_agent_runtime.md), [Workflow Coordinator Internal Agent](../specs/20260704-workflow_coordinator_internal_agent.md), [Worker Sandbox Freedom Policy](../specs/20260709-worker_sandbox_freedom_policy.md), [Test Strategy](../specs/20260529-test_strategy.md), [L6 Story Acceptance](../specs/20260529-l6_story_acceptance.md).

## Current Baseline

- Self-improvement loop, Reflector, Harness, Judge, `EvalTask`, suites, and improvement proposals: zero implementation.
- Durable scheduler V1 is implemented (admission, plans, leases, dispatch/lease-watch/probe loops, restart recovery); it has no recurring primitive. `apps/nanocore/src/lib/automation-store.ts` is an unpersisted in-memory automation store with no executor.
- Skills are supplied from the hardcoded `WORKER_SKILL_CATALOG` const in `apps/nanocore/src/runtime/agent-environment.ts`; no versioning, pinning, or persistence.
- Knowledge governance V1 is implemented (proposals, review, conflict detection, low-risk repairs); provisional auto-promotion is spec-only.
- Context packages have deterministic digests and digest-checked materialization readback; per-entry replay reconstruction is spec-only.
- Evidence bundles, audit events, usage records, Action Center projections, and workspace export/import with coverage guards are implemented and are the substrate this change may compose. The rejected generic internal-agent runner, registry, event loop, hook system, diagnostics ledger, and private lifecycle have been deleted by the G01 correction; G07 must not recreate or reuse them.

## Execution Plan

Ordering follows spec dependencies and the owning spec's rollout phases. Each stage lands test-first with package-by-package conventional commits.

### Stage 0 — Spec acceptance

- Review the three Draft specs (`20260711-scheduler_recurring_event_triggers`, `20260711-skill_catalog_versioning_pinning`, `20260711-evaluation_harness_design`) and move them to `Status: Accepted` before their implementation stages begin.
- Resolve the harness spec's `[Blocking]` open question (judge sandbox LLM-call posture: harness-process dispatch outside any sandbox is the preferred lean).
- Accept `20260710-self_improvement_evaluation_loop.md` and promote the Task Evaluator placeholder resolution into `docs/core/architecture.md`'s internal role table.

### Stage 1 — Trigger substrate

Implements `20260711-scheduler_recurring_event_triggers.md`.

- Schedule and fire record layer, cadence next-occurrence math, due-row query.
- Tick loop service with fire procedure (overlap, budget stub, enqueue, advance), epoch stamping, coalescing catch-up, crash re-drive.
- Delete `automation-store.ts`; re-point automation App API routes at the schedule read model and governed operations.
- Audit events and Action Center row on repeated fire failure.

### Stage 2 — Knowledge provisional auto-promotion (self-improvement Phase 1 gate)

Implements the Provisional Auto-Promotion section of `20260702-knowledge_store_governance_rules.md`.

- Additive-diff eligibility check, designated-type allowlist, conflict-detection gating, silent escalation to normal review.
- `provisional` review state, TTL and citation-counter fields, confirmation and expiry transitions, one-step rollback, audit and proposal-history visibility.
- TTL/citation sweeps as recurring schedules from Stage 1.

### Stage 3 — Reflector memory loop (self-improvement Phase 1)

- This plan does not authorize a persistent Reflector agent or reuse of the generic internal-agent framework. Before implementation, S18 and S19 must be accepted with one bounded Reflector operation: the existing scheduler owner invokes a concrete request-scoped role function over durable projection-only inputs, and the existing Knowledge Proposal owner persists any output. The operation has no private session, event loop, checkpoint, retry queue, hook system, or independently resumable lifecycle.
- Reflection cadence as `system`-origin recurring schedules; event triggers (redo, review rejection, negative feedback) inserting deduped one-shot trigger rows per the trigger convention.
- Rubric records feeding Workflow Coordinator context material.
- Self-improvement usage category on bounded reflection invocations (metering visibility; enforcement stays deferred).

Value checkpoint: the loop is live end to end on the knowledge path before any harness work.

### Stage 4 — Skill Catalog versioning and pinning (Phase 2 prerequisite)

Implements `20260711-skill_catalog_versioning_pinning.md`.

- `skv1` digest utility; entry/version/pin records and content-addressed storage; publish/promote/rollback/pin/unpin/deprecate with governance tiers and audit.
- AEP resolution switch from `WORKER_SKILL_CATALOG` to records with digest recording and digest-verified materialization; bootstrap seeding of repository-authored skills.
- App API, Core Client, and end-user operation-catalog surfaces; workspace export scope additions with coverage-guard wiring.

### Stage 5 — Context package replay reconstruction (Phase 2 prerequisite)

Implements the Replay Reconstruction contract of `20260703-worker_context_package.md`.

- Per-entry frozen reconstruction from recorded source references with typed `source_unavailable` / `digest_mismatch` / `revision_unavailable` outcomes and entry-level result reporting.
- Redaction parity with original materialization; reconstruction readback API for harness consumption.

### Stage 6 — Evaluation Harness (self-improvement Phase 2 core)

Implements `20260711-evaluation_harness_design.md`.

- Evaluation area layout, `EvalTask` and suite snapshot records, harvest tooling fed by Reflector nominations; export-family wiring per the updated backup/export spec.
- Candidate execution over scheduler-admitted `maintenance` turns with retained-snapshot materialization and fixed budgets; error continuation; mechanical metrics from usage/audit rows; curve recording. The first implementation runs candidate work in one disposable Cell epoch and completes its recycle before Judge execution begins.
- Judge sandbox runner with the held-back acceptance zone in a second fresh disposable Cell epoch; Judge LLM dispatch with routing table, blinding, sealed ordering, and A/A injection. Concurrent candidate and Judge Cells remain blocked until multi-Cell capacity is designed and proved.
- Run records, evidence bundles, audit categories, read-only projections; harness version and comparability refusal.

### Stage 7 — Improvement proposal lifecycle (self-improvement Phase 2 completion)

- `ImprovementProposal` records with the owning spec's lifecycle: mechanical gate auto-rejection, snapshot pinning, batch separation, tiered approval.
- `improvement_proposal` Action Center rows per the updated human-attention spec: evidence-bundle requirement, approve/reject, post-promotion rollback surfacing.
- Skill-version proposals end to end: Reflector draft → harness evaluation → Action Center approval → catalog pointer promotion (Stage 4) → outcome telemetry links → Reflector post-promotion review and rollback proposals.
- Prompt-template proposals to the extent a versioned prompt-template substrate exists; if it needs its own pointer-and-digest substrate, split a follow-up spec rather than improvising (see Risks).

### Stage 8 — Coordination reflection and long-horizon tier (self-improvement Phases 3-4)

- Counterfactual Coordinator-decision review producing `coordinator-spec-draft` proposals (never auto-applied) and guard-metric health-sweep dashboards over run records.
- 5-10 day-scale L6 stories with trajectory-curve reporting and error continuation, extending `docs/specs/20260529-l6_story_acceptance.md`; run per release.
- This stage may be split into its own change record at the Stage 7 checkpoint if the release rhythm favors closing this record at Phase 2 completion.

## Verification Plan

- Each stage satisfies the Testing Strategy / Acceptance Criteria section of its owning spec (L0-L3 deterministic suites; L5 smoke where specified) before the stage checkpoint is recorded.
- Cross-cutting invariants verified explicitly at Stage 6/7: no candidate-visible path to held-back acceptance material; results from differing pinned environments cannot be aggregated; promotion never mutates pins; no proposal surfaces for review without an evidence bundle; suite-curation and behavior-change decisions never batch together; all loop activity lands in audit and the self-improvement usage category.
- L6 stories at closure: daily automation with coalesced catch-up after downtime (Stage 1); a redo event producing a reflection that yields a provisional lesson which is later confirmed by citation (Stages 2-3); a skill-version proposal evaluated, approved with evidence, promoted without unpinning, and rolled back one step (Stages 4-7).
- Final verification evidence, remaining follow-ups, and commit/PR links close this record per `docs/change-tracking.md`.

## Expected Handoff Points

- Stage boundaries are the handoff points; each ends with a checkpoint entry here (completed scope, deviations, verification results, commits).
- Stage 0 requires engineer approval of spec acceptance and the blocking-question resolution.
- Stages 1-2, 4-5 are independent enough to parallelize across agents after Stage 0; Stage 3 needs Stages 1-2; Stage 6 needs Stages 1, 4, 5; Stage 7 needs Stage 6.
- Any discovered contract gap goes back into the owning spec (or a new spec) before the affected implementation proceeds, per the spec-first rule.

## Known Risks

- Prompt-template versioning has no substrate spec; Stage 7 may force a follow-up spec, delaying full Phase 2 closure. Mitigation: skill-version proposals do not depend on it; land them first.
- Replay reconstruction (Stage 5) depends on source-record retention quality; harvested tasks whose sources have drifted retire early, shrinking initial suites. Mitigation: retained snapshots are the primary replay path; reconstruction is the fallback and drift detector.
- The sequential two-Cell harness profile adds sandbox-lifecycle load; provisioning cost could dominate minute-scale runs. Mitigation: minimal Judge profile, mechanical checks before LLM dispatch, and no concurrent or warm reuse until multi-Cell ownership is proved.
- Metering enforcement does not exist; budget caps rely on the trigger mechanism's deferral stub until it does. Mitigation: consumption is visible from Stage 3 via the usage category, so runaway cost is observable before enforcement lands.
- Scope breadth: eight stages across scheduler, knowledge, supply, sandbox, and review surfaces invites drift. Mitigation: stage checkpoints in this record, spec-first gap handling, and the option to split Stage 8.

## Checkpoints

- 2026-07-11 — Record created; all owning specs drafted or updated; implementation not started.
