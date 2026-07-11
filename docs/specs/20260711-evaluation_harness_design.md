# Evaluation Harness Design

Status: Draft
Implementation: Not Started

## Owns

- The concrete runtime design of the Evaluation Harness contracted in `docs/specs/20260710-self_improvement_evaluation_loop.md`: run orchestration, record shapes, and versioning.
- The work/judge two-sandbox execution profile, including the rule that candidate workers have no read path to acceptance checks.
- The evaluation area layout: `EvalTask` records, suite snapshot records, fixtures, and run results under the workspace data root.
- Harness versioning and the environment identifiers stamped into every result.
- The Judge call execution mechanics: how the blind pairwise call is dispatched, isolated, and recorded.
- Evidence assembly from harness runs into `EvidenceBundle` records.

## Does Not Own

- The evaluation and self-improvement model itself: roles, separation invariants, proposal lifecycle, tiers, signals, and Goodhart guards. `docs/specs/20260710-self_improvement_evaluation_loop.md` owns all of that; this spec implements its Harness and Judge contracts and must not restate or weaken them.
- Reflector behavior, trajectory mining, or proposal drafting.
- Sandbox concepts, isolation areas, and backend containment. `docs/core/sandbox.md` owns those; this spec composes existing scopes into an evaluation profile.
- Scheduler admission, leases, or the recurring-trigger mechanism. `docs/specs/20260703-durable_scheduler_design.md` and `docs/specs/20260711-scheduler_recurring_event_triggers.md` own those.
- Context package replay reconstruction. `docs/specs/20260703-worker_context_package.md` owns it; the harness is its first heavy consumer.
- Skill version identity and pinning. `docs/specs/20260711-skill_catalog_versioning_pinning.md` owns those.
- `EvidenceBundle` schemas, audit categories, metering records, and Action Center rows; their owning specs apply.

## Core References

- `docs/core/sandbox.md`
- `docs/core/architecture.md`
- `docs/core/audit.md`
- `docs/core/metering.md`

## Related Specs

- `docs/specs/20260710-self_improvement_evaluation_loop.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260711-skill_catalog_versioning_pinning.md`
- `docs/specs/20260711-scheduler_recurring_event_triggers.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260709-worker_sandbox_freedom_policy.md`
- `docs/specs/20260529-test_strategy.md`

## Summary

The self-improvement spec contracts the Evaluation Harness as "versioned NanoCore code, not an agent" that materializes evaluation tasks into isolated sandboxes, runs candidates under fixed budgets, computes mechanical metrics, invokes a blind Judge, and assembles evidence — with acceptance checks running where candidates cannot read them. That spec deliberately stops at the contract level.

This spec is the runtime design: the record shapes for `EvalTask`, suite snapshots, and run results; the evaluation area layout under the workspace data root; the two-sandbox execution profile that realizes work/judge isolation with existing sandbox primitives; the harness versioning rule that makes every comparison reproducible; the Judge dispatch mechanics; and the projection of run outputs into evidence bundles, audit events, and usage records. It is the Phase 2 gate of the self-improvement rollout.

## Goals / Non-goals

### Goals

- Realize every Harness and Judge requirement of the self-improvement spec with existing primitives: worker sandboxes, context package replay, evidence bundles, audit, usage records, and the durable scheduler.
- Make work/judge isolation structural: the candidate sandbox never contains, mounts, or can fetch acceptance checks or held-back assertions.
- Make every run reproducible from its recorded environment: harness version, suite snapshot id, rubric snapshot id, model ids, budgets, and context package digests.
- Keep the harness cheap: proposal-gate runs are minute-scale per task and run under `maintenance` scheduling priority.

### Non-goals

- Do not re-decide anything the self-improvement spec resolved: suite storage location, context snapshot fidelity, judge model routing, graduation quorum, and budget accounting are accepted inputs.
- Do not build a general CI system or replace the L0-L6 test strategy; the harness evaluates workspace assets, not repository code.
- Do not implement the long-horizon L6 tier; only the proposal gate and health sweep tiers are in scope.
- Do not give the harness any write path to skills, prompts, rubrics, or suites — restated from the owning spec because the implementation must enforce it, not merely observe it.

## Background

The self-improvement spec resolved the design questions that shape this implementation: evaluation data lives in a dedicated evaluation area under the workspace data root, not the knowledge store; replay freezes the worker context package with minimal fixtures materialized at harvest time; judge model routing is a NanoCore-level default table with per-workspace override; and self-improvement consumption is metered as its own category.

The prerequisite substrate now exists at spec level: context package replay reconstruction is contracted in `docs/specs/20260703-worker_context_package.md`; skill versions are digest-identified and pinnable per `docs/specs/20260711-skill_catalog_versioning_pinning.md`, so a candidate skill version and its incumbent are both exactly addressable; recurring and event triggers per `docs/specs/20260711-scheduler_recurring_event_triggers.md` drive when evaluation runs happen; and `EvidenceBundle` records are implemented for evidence indexing.

The two-container work/judge rule follows EdgeBench's isolation principle, already adopted by the owning spec: evaluation hacking is prevented at the root by making the acceptance material physically absent from the candidate's environment, not by asking the candidate not to look.

## Decision

- The harness is a NanoCore-internal service module with a declared **harness version** string, bumped on any behavior-affecting change; the version is stamped into every result and MUST be equal across all runs inside one comparison.
- Each evaluation task run uses **two sandboxes**: a standard worker sandbox for the candidate (normal worker profile, evaluation-flagged) and a short-lived **judge sandbox** materialized only after the candidate sandbox is terminated or sealed, containing the candidate's outputs, the acceptance checks, and nothing writable by the candidate.
- Acceptance checks and held-back assertions are stored in the evaluation area **outside every candidate-mountable path** and are never part of a candidate's context package, workspace inputs, or supply.
- Candidate runs execute as **scheduler-admitted turns** at `maintenance` priority, so evaluation load competes under normal fairness, backpressure, and metering rather than through a side channel.
- The **Judge call** is dispatched by the harness through the normal LLM gateway with a dedicated evaluation usage category, a judge-routing table resolved at run start, randomized candidate ordering, and a recorded rubric snapshot id; it runs with no tools and no session state.
- Every suite run produces one **evaluation run record** in the evaluation area plus one `EvidenceBundle` index row; per-task trajectories remain linked, not copied.

## Contract / Expected Behavior

### Evaluation area layout

The evaluation area lives under the workspace data root, separate from the knowledge store, and is included in workspace export scope per `docs/specs/20260704-workspace_backup_export_import.md`:

```text
evaluation/
  suites/<suiteSnapshotId>/manifest.json        # immutable snapshot: task ids, digests, created-at
  tasks/<evalTaskId>/task.json                  # EvalTask record
  tasks/<evalTaskId>/context/                   # retained context package snapshot
  tasks/<evalTaskId>/fixtures/                  # harvest-time file fixtures
  tasks/<evalTaskId>/acceptance/                # acceptance checks and held-back assertions
  runs/<runId>/run.json                         # evaluation run record
  runs/<runId>/tasks/<evalTaskId>/              # per-task outcomes, curves, judge verdicts
```

Rules:

- Suite snapshots are immutable: a manifest lists member task ids with their `task.json` content digests. Any curation change produces a new snapshot id. Snapshot manifests MUST verify offline against the listed digests.
- `EvalTask` records carry the fields contracted by the owning spec; this spec fixes their storage form (JSON records with digest-listed fixture manifests) and adds a `contextPackageDigest` linking the retained snapshot.
- The `acceptance/` subtree is the **held-back zone**. Nothing under it may be referenced by, copied into, or mounted in a candidate sandbox, a candidate context package, or candidate-visible supply. This MUST be enforced by construction (the candidate materialization path has no code path that reads the held-back zone) and asserted by test.
- Fixture and context snapshots are retained copies per the replay contract in `docs/specs/20260703-worker_context_package.md`; suite refresh uses that contract's entry-level digest-mismatch signal to flag drifted tasks for retirement.

### Run orchestration

A proposal-gate run evaluates one candidate configuration against one incumbent configuration over one pinned suite snapshot:

1. **Pin.** Resolve and record the environment: harness version, suite snapshot id, rubric snapshot id, candidate and incumbent asset digests (skill version digests, prompt template refs), worker model id, judge model id from the routing table, and per-task budgets from the `EvalTask` records. The environment record is immutable for the run; any resolution change aborts before execution.
2. **Execute candidates.** For each task and each side (candidate, incumbent), materialize the retained context snapshot and fixtures into a standard worker sandbox and run the task as a scheduler-admitted `maintenance` turn under the task's recorded budget (model, step cap, token cap, wall clock). Both sides of one task MUST run under identical budgets and harness version.
3. **Error continuation.** A worker error does not abort the task run; the harness records it, allows recovery within budget, and flags recovered-error trajectories for Reflector analysis, per the owning spec.
4. **Judge phase.** After a side's execution terminates, its declared outputs are collected. The judge sandbox for a task is materialized fresh with: both sides' outputs under neutral labels in randomized order, the task input, and the acceptance checks from the held-back zone. Mechanical acceptance checks execute there; rubric questions dispatch as Judge calls. The judge sandbox has no network egress except the LLM gateway path used by the harness itself, no workspace mounts, and is destroyed after verdict recording.
5. **Score.** Mechanical metrics (steps, tokens, cost, wall clock, tool-error rate, permission denials, gate hits) are computed from the turn's existing usage and audit records, not self-reported by the worker. Where acceptance checks are repeatable, score-at-checkpoint curves are recorded per the owning spec.
6. **Assemble.** Write the evaluation run record, create one `EvidenceBundle` indexing per-task outcomes, curves, verdicts with rubric snapshot id, environment identifiers, and trajectory links, and emit audit events for run start, per-task completion, judge verdicts, and run completion.

Concurrency: tasks within a run MAY execute in parallel up to scheduler capacity; the two sides of one task MAY run in either order but MUST NOT share a sandbox, and neither side's sandbox may outlive its own execution into the judge phase.

### Work/judge isolation profile

- Candidate sandbox: the standard worker sandbox profile under `docs/core/sandbox.md` and `docs/specs/20260709-worker_sandbox_freedom_policy.md`, with turn lineage marked `evaluation` so capability calls, usage, and audit are attributable. Candidates get the capabilities the original task's AEP would grant, minus anything that could reach the evaluation area: no capability route may expose `evaluation/` paths, suite records, or run records to a worker.
- Judge sandbox: ephemeral, turn-scoped, created from harness-controlled inputs only. It mounts candidate outputs read-only, the acceptance material read-only, and a writable scratch area for check execution. It has no access to workspace roots, the knowledge store, vault material, or MCP servers. Its existence, inputs manifest, and teardown are audited.
- The Judge LLM call context contains exactly: the task input, the rubric snapshot content, and the two outputs under neutral labels. It MUST NOT contain proposal rationale, author identity, version labels, incumbent markers, or workspace identity beyond what the rubric itself states. Ordering randomization and label assignment are recorded (sealed in the run record, not shown to the judge).
- A/A self-preference audits per the owning spec are implemented as harness-injected identical pairs at a configurable rate (default 1 in 50 comparisons); failed A/A consistency flags the judge configuration in the run record and marks its recent verdicts low-confidence.

### Harness versioning and comparability

- The harness version is a single declared constant covering orchestration, metric computation, curve recording, and judge dispatch behavior. Any change to those behaviors MUST bump it.
- Results are comparable only when harness version, suite snapshot id, model ids, and budgets are all equal. The harness MUST refuse to aggregate or diff results across differing environments, and the refusal is typed.
- Run records embed the environment identifiers redundantly (in `run.json` and in the evidence bundle) so comparability is checkable from either side.

### Scheduling and budgets

- Proposal-gate runs are triggered by proposal submission (Reflector output); health sweeps are recurring schedules under `docs/specs/20260711-scheduler_recurring_event_triggers.md` (default nightly, `maintenance` class).
- All evaluation turns are metered under the self-improvement consumption category defined by the owning spec. When the per-workspace cap is exhausted, pending evaluation work queues via the trigger mechanism's budget deferral rather than dropping.
- Per-task budget enforcement uses the existing bounded-step and lease machinery; a budget-exceeded task terminates at the cap and is scored on the trajectory up to termination — exceeding budget is a recorded outcome, not a run failure.

### Failure behavior

- A harness infrastructure failure (sandbox launch failure, materialization failure, gateway outage) marks the affected task result `infrastructure-failed` and excludes it from comparison; a run with any `infrastructure-failed` task MUST NOT produce a regression-gate verdict and is retried as a whole under the same pinned environment.
- Judge call failures after bounded retries mark the comparison `verdict-unavailable`; mechanical checks still record. A proposal cannot pass its gate with unavailable verdicts on rubric-gated tasks.
- All failure modes land in audit; repeated infrastructure failures surface an Action Center row for the operator.

## Proposed Design

The harness is a module family under NanoCore (orchestrator, environment pinning, candidate execution adapter over the existing turn/scheduler path, judge sandbox runner, metric collector over usage/audit projections, evidence assembler). Suite snapshot and run records are file-backed JSON in the evaluation area with content digests, following the file-system-first posture of workspace records; SQLite carries only derived read-model indexes. The judge routing table is NanoCore configuration with per-workspace override records. Judge calls go through the existing LLM gateway with a dedicated usage category and a no-tools, no-session profile. Read-only App API / core-client / MCP projections expose suite content, run results, and evidence links for product surfaces and for the Reflector's projection-based inputs.

## Current Implementation Projection

Nothing in this contract is implemented. Existing substrate this design composes: worker sandbox lifecycle and turn execution (orchestrator, scheduler, leases); context package materialization with digest-checked readback (`apps/nanocore/src/…` per the context package spec's projection; full replay reconstruction is contracted but not yet implemented — it is a build dependency of this spec); `EvidenceBundle` creation and indexing (`apps/nanocore/src/evidence-bundles.ts`); usage and audit records for mechanical metrics; and the internal-agent framework the Reflector will use (out of scope here). The recurring-trigger mechanism and Skill Catalog versioning are Draft prerequisites (`20260711-scheduler_recurring_event_triggers.md`, `20260711-skill_catalog_versioning_pinning.md`).

## Alternatives Considered

- Running acceptance checks inside the candidate sandbox after execution. Rejected: the candidate can read, cache, or overfit to the checks during execution; physical absence is the only robust rule, per the owning spec's isolation invariant.
- Implementing the harness as an internal agent. Rejected by the owning spec's decision: evaluation is pushed into code so the agentic judgment surface stays minimal; an agent harness would also break the proposer/evaluator identity separation.
- A dedicated evaluation executor bypassing the scheduler. Rejected: a side channel would escape fairness, backpressure, metering, and lease recovery; evaluation load must be visible, schedulable, and cancellable like all other load.
- Storing suite and run records in SQLite as source of truth. Rejected: they carry file fixtures and context snapshots, are immutable once written, and must export/verify offline — the file-backed posture with digests fits; SQLite keeps derived indexes only.
- Letting the judge see version labels to "explain" its verdict better. Rejected: blindness is a hard invariant of the owning spec; explanation quality is addressed by rubric quality, not identity leakage.

## Consequences

- Work/judge isolation becomes a mechanical property of materialization paths, testable at L2/L3, instead of a convention.
- Evaluation load is fully governed: admitted, metered, audited, and budget-capped like product load, at the cost of evaluation latency being subject to queue conditions.
- The evaluation area adds a new export family and a new file-backed record discipline to maintain.
- Context package replay reconstruction moves from nice-to-have to hard dependency; its implementation order gates Phase 2.
- Harness version discipline adds friction to harness changes by design: silent behavior drift between comparisons is the failure mode being purchased away.

## Rollout / Migration Plan

New machinery; no migration. Order, aligned with the owning spec's Phase 2: (1) evaluation area layout, `EvalTask`/suite snapshot records, and harvest tooling fed by Reflector nominations; (2) candidate execution path over scheduler-admitted evaluation turns with context/fixture materialization; (3) judge sandbox runner with mechanical acceptance checks; (4) Judge LLM dispatch with routing table, blinding, and A/A injection; (5) run records, evidence bundles, audit, and read-only projections; (6) health-sweep recurring schedules. Prerequisites tracked in their own specs: replay reconstruction implementation, Skill Catalog records, recurring triggers.

## Testing Strategy / Acceptance Criteria

Mapped to `docs/specs/20260529-test_strategy.md`:

- L0: schema-drift checks for evaluation record shapes; repo check that no candidate-facing module imports the held-back-zone reader.
- L1: unit tests for environment pinning and comparability refusal, suite snapshot immutability and digest verification, label randomization sealing, A/A injection accounting, curve recording, and budget-cap outcome classification.
- L2: contract tests that candidate materialization cannot reference `acceptance/` paths (path-level denial), that judge call contexts contain no forbidden fields (rationale, labels, incumbent markers), that mechanical metrics derive from usage/audit rows rather than worker output, and that evaluation turns carry the evaluation lineage flag and usage category.
- L3: NanoCore black-box tests: a full two-sided run over a fixture suite producing a run record, evidence bundle, and verdicts; a candidate that attempts to read acceptance material and fails; a mid-run NanoCore restart recovering or cleanly retrying the run under the same pinned environment; budget exhaustion queueing a run via trigger deferral; an `infrastructure-failed` task blocking the regression verdict.
- L5: smoke test that a packaged build executes one single-task evaluation run end to end.
- L6: story acceptance covering a skill-version proposal evaluated, surfaced with evidence in Action Center, approved, promoted, and rolled back.

Acceptance criteria: no code path can place held-back material in a candidate-visible location; results from differing environments cannot be aggregated; every run is reproducible from its recorded environment identifiers given retained snapshots; all evaluation consumption appears under the self-improvement metering category; every verdict records rubric snapshot id, judge model id, and sealed ordering.

## Risks & Mitigations

- Risk: retained context snapshots and fixtures bloat the workspace data root. Mitigation: suites are capped small by the owning spec (10-30 tasks); fixtures are minimal by harvest rule; retired tasks are prunable once no run references them.
- Risk: judge sandbox provisioning cost dominates minute-scale runs. Mitigation: the judge sandbox is a minimal profile (no workspace materialization, no supply); mechanical checks run before any LLM dispatch so rubric calls are the only expensive step.
- Risk: scheduler queueing makes proposal gates slow under load. Mitigation: intended behavior — evaluation yields to product work; the proposal lifecycle is asynchronous and Action Center shows `evaluating` status.
- Risk: harness version bumps invalidate long-running comparison baselines. Mitigation: comparisons are short-lived by design (per proposal); health-sweep trend dashboards annotate version boundaries instead of pretending continuity.
- Risk: the evaluation lineage flag leaks into worker-visible context and changes candidate behavior. Mitigation: the flag lives in turn lineage records only; contract test asserts the candidate-visible package is byte-identical to a non-evaluation materialization of the same snapshot.

## Open Questions

- [Blocking] Judge sandbox network posture: whether the judge sandbox itself may call the LLM gateway directly (simpler) or all rubric calls are dispatched by the harness process outside any sandbox (stricter, preferred lean) — affects the containment story and must be settled before acceptance.
- [Non-blocking] Whether health-sweep results should feed a dedicated read model for trend dashboards at V1 or reuse raw run records until Web UI work lands.
- [Non-blocking] Retry budget defaults for judge call failures before `verdict-unavailable` (initial lean: 3 attempts with backoff).

## Deferred / Future Work

- The long-horizon L6 story tier with trajectory-curve reporting and error continuation (owned as a follow-up of the self-improvement spec against `docs/specs/20260529-l6_story_acceptance.md`).
- Cross-workspace shadow evaluation execution for graduation quorums (mechanism owned by the self-improvement spec; scheduling and sampling design deferred until Phase 2 is proven on single workspaces).
- Suite pruning/garbage collection for retired tasks and superseded snapshots.
- Warm judge-sandbox reuse if provisioning cost proves material.

## Links

- `docs/specs/20260710-self_improvement_evaluation_loop.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260711-skill_catalog_versioning_pinning.md`
- `docs/specs/20260711-scheduler_recurring_event_triggers.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260704-workspace_backup_export_import.md`
- `docs/specs/20260709-worker_sandbox_freedom_policy.md`
- `docs/core/sandbox.md`
- `docs/specs/20260529-test_strategy.md`
