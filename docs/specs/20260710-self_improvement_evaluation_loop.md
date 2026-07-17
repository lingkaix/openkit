# Self-Improvement Evaluation Loop

Status: Draft
Implementation: Not Started

## Owns

- The OpenKit evaluation and self-improvement model that resolves the Task Evaluator placeholder in `docs/core/architecture.md`.
- The Reflector internal-agent contract: trajectory mining, improvement proposal drafting, and evaluation-asset curation.
- The Evaluation Harness contract: suite execution, sandbox isolation, mechanical metrics, budget rules, and evidence assembly.
- The Judge call convention: blind pairwise quality comparison as a stateless, rubric-driven LLM call.
- Per-workspace evaluation assets: regression suites, rubric/preference profiles, and outcome telemetry links.
- Improvement proposal records, their tiered approval model, and their promotion/rollback lifecycle.
- Anti-gaming invariants: proposer/evaluator separation, suite snapshot pinning, batch separation, and Goodhart guards.
- The trigger model that connects reflection runs to the durable scheduler and to workflow events.

## Does Not Own

- The canonical internal-role table. `docs/core/architecture.md` owns it; this spec proposes the resolution of its Task Evaluator placeholder as a follow-up core update.
- Workflow Coordinator routing, worker selection, or semantic worker-context composition. `docs/specs/20260704-workflow_coordinator_internal_agent.md` owns those; mode specs own durable state, materialization, and delivery.
- Knowledge model, knowledge proposals, or Knowledge Manager maintenance behavior. `docs/core/knowledge.md` and `docs/specs/20260702-knowledge_store_governance_rules.md` own those; this spec only defines how rubric and lesson updates flow through the existing knowledge proposal path.
- Goal Mode, Task Mode, or Chat Mode semantics. The mode specs own those.
- Skill file format, Skill Catalog storage, or Skill Creator authoring UX. This spec depends on Skill Catalog versioning but does not define it.
- Human Attention gate mechanics, Action Center internals, audit record schemas, sandbox containment, scheduler internals, or the L0-L6 test strategy itself.
- Model training, fine-tuning, or any form of weight-level learning.

## Core References

- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/core/work-model.md`
- `docs/core/knowledge.md`
- `docs/core/audit.md`
- `docs/core/sandbox.md`
- `docs/core/permissions.md`
- `docs/product-vision.md`

## Related Specs

- `docs/specs/20260704-workflow_coordinator_internal_agent.md`
- `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`
- `docs/specs/20260711-scheduler_recurring_event_triggers.md`
- `docs/specs/20260711-skill_catalog_versioning_pinning.md`
- `docs/specs/20260711-evaluation_harness_design.md`
- `docs/specs/20260704-goal_mode_coordination.md`
- `docs/specs/20260702-knowledge_store_governance_rules.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260529-l6_story_acceptance.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/specs/20260531-human_attention_intervention_model.md`

## Summary

OpenKit workspaces accumulate skills, prompts, rubrics, and coordination behavior that today only improve when a human notices a problem. This spec defines a governed self-improvement loop: a Reflector internal agent mines completed work trajectories, drafts improvement proposals, and nominates evaluation tasks; a frozen Evaluation Harness replays proposals against versioned per-workspace regression suites inside isolated sandboxes; a blind stateless Judge compares candidate outputs pairwise against workspace rubrics; and humans approve promotion through the existing Action Center gates.

The design deliberately separates three concerns that must never share one identity: proposing changes (agent), measuring changes (code plus stateless judge), and accepting changes (human). Evaluation is pushed into code wherever possible so that the agentic judgment surface stays minimal.

The loop is explicitly not unattended recursive self-improvement. Every behavior-changing promotion passes a mechanical regression gate and a human approval gate, consistent with the Goal Mode non-goal in `docs/specs/20260704-goal_mode_coordination.md`.

## Goals / Non-goals

### Goals

- Give every workspace a durable, growing set of evaluation assets harvested from its own real work history.
- Make skill versions, worker prompt templates, and knowledge/rubric content continuously verifiable and improvable.
- Keep the proposer, the evaluator, and the approver structurally separated.
- Reuse existing primitives end to end: proposals are artifacts, approvals go through Action Center, evidence uses evidence bundles, activity lands in audit, scheduling uses the durable scheduler, and rubric updates use knowledge proposals.
- Make every evaluation run reproducible: pinned suite snapshot, pinned model, fixed budget, recorded harness version.
- Capture failures and recoveries as first-class evaluation data rather than discarding failed trajectories.

### Non-goals

- Do not create unattended recursive self-improvement. Humans remain the promotion gate for behavior changes.
- Do not build a universal benchmark. Suites measure regression against a workspace-local distribution, not cross-model rankings.
- Do not evaluate or mutate NanoCore code automatically. Coordinator-level findings become spec proposals for humans, not applied patches.
- Do not require day-scale evaluation runs in the proposal loop. Long-horizon evaluation lives in the release-level L6 tier only.
- Do not add a second persistent evaluation agent. One Reflector, one harness, one judge convention.
- Do not let one workspace's preferences mutate a shared Skill Catalog entry. Workspace-specific learning lands in workspace-layer assets.

## Background

Three observations motivate this design.

First, `docs/core/architecture.md` already reserves a Task Evaluator internal role "for evaluating task outcomes, workflow or Skill updates, verification evidence, and measurable improvement before changes are accepted", explicitly deferred "until the evaluation, test, verification, and measurement model is designed". This spec is that design.

Second, external prior art converges on a small set of loop-engineering principles. karpathy/autoresearch demonstrates a minimal working improvement loop: a single mutable artifact, a frozen harness, a fixed time budget, one verifiable metric, and keep/discard regression logic — with the evaluator implemented as frozen code rather than an agent. ByteDance Seed's EdgeBench (SForge harness) adds long-horizon principles: errors must not terminate trajectories because recovery behavior is signal; scores should be trajectory curves, not endpoint values; and work/judge two-container isolation prevents evaluation hacking at the root. This spec adopts the principles of both while rejecting their scale assumptions: OpenKit evaluates skills, prompts, and coordination on top of fixed models, so the proposal loop needs minute-scale, cheap, high-frequency runs.

Third, OpenKit already possesses the expensive parts of an evaluation system as production side effects. Audit projections, thread/turn/item history, evidence bundles, redo/refinement/steering events, and review states are exactly the telemetry an evaluator needs, and real workspace tasks with clear outcome signals are free evaluation-task candidates — where academic benchmarks pay tens of expert hours per authored task.

## Decision

- One new persistent internal agent, the **Reflector**, joins the Core coordination plane. It mines trajectories, drafts improvement proposals, and nominates evaluation-asset changes. It never scores its own proposals and never applies changes.
- The **Evaluation Harness** is versioned NanoCore code, not an agent. It materializes evaluation tasks into isolated worker sandboxes, runs candidates under fixed budgets, computes mechanical metrics, invokes the Judge, and assembles evidence bundles. Acceptance checks run in a separate judge sandbox that candidate workers cannot read.
- The **Judge** is a stateless, blind, rubric-driven pairwise comparison call. It is a call convention with isolation requirements, not a registered agent. It should default to a different model than the proposer.
- Each workspace accumulates three **evaluation assets**: a versioned regression suite of harvested golden tasks, a rubric/preference profile maintained as governed knowledge records, and outcome telemetry links that connect promoted changes to downstream real-world signals.
- Improvement proposals are typed records with **tiered approval**: knowledge/rubric updates ride the existing lightweight knowledge proposal path; skill and prompt mutations require full Action Center approval; coordinator-level findings become draft spec documents for human review only.
- The **Task Evaluator placeholder** in `docs/core/architecture.md` resolves into this Reflector + Harness + Judge decomposition. Promoting that resolution into the core role table is a follow-up core update once this spec is accepted.

## Contract / Expected Behavior

### Roles and separation invariants

| Concern | Owner | Form |
| --- | --- | --- |
| Propose changes, curate assets | Reflector | Persistent internal Core agent |
| Execute suites, compute metrics, enforce budgets | Evaluation Harness | Versioned NanoCore code |
| Compare candidate quality | Judge | Stateless blind LLM call |
| Accept, reject, roll back | Human | Action Center / knowledge review |

Separation invariants:

- The Reflector must not execute evaluation runs, compute scores, or write suite results.
- The Harness must not modify skills, prompts, rubrics, or suites.
- The Judge must not see proposal rationale, author identity, version labels, or which candidate is the incumbent. It receives two outputs, the task input, and the rubric.
- No proposal may be promoted without a Harness-produced evidence bundle attached.

### Reflector

The Reflector is an internal Core agent in the same sense as Workflow Coordinator and Knowledge Manager: it stays inside the coordination plane, is not a worker agent, not an agent supply entry, and not user-selectable for execution.

Inputs (all via existing projections; no raw store access):

- thread/turn/item history and evidence bundles for completed work
- audit projections for capability calls, permission decisions, and sandbox lifecycle
- redo, refinement, steering, review, and Human Attention events
- skill version selection and pinning events from the Skill Catalog
- suite run results produced by the Harness
- outcome telemetry linked to previously promoted changes

Outputs (all proposals, never applied changes):

- `ImprovementProposal` records (see below)
- evaluation-task nominations and suite curation proposals
- rubric and lesson updates submitted as knowledge proposals under `docs/specs/20260702-knowledge_store_governance_rules.md`
- coordinator-level findings drafted as spec proposal documents

Reflection analysis must cover trajectory-internal behavior, not only outcomes: whether the worker detected its own errors, how it recovered, where steps were wasted, and which context material was used versus ignored. Recovery patterns and failure modes are primary rubric/lesson material.

### Evaluation assets

Each workspace owns three assets.

**Regression suite.** A versioned set of `EvalTask` records harvested from real workspace history. An `EvalTask` must carry:

- task input and instructions as given
- a context snapshot reference sufficient to reproduce the worker context
- acceptance checks: mechanical assertions where possible, rubric references otherwise
- the originating thread/item references and the outcome signal that justified harvesting
- fixed execution budget (model, step cap, token cap, wall-clock cap)
- category tags (recent-failure, high-value-success, edge-case)

Curation rules: harvesting favors signal-clear cases; fixed failures must enter the suite once fixed; suites stay small (target 10-30 tasks per workspace) and stratified; the Reflector proposes additions, replacements, and retirements; humans approve suite changes on the lightweight tier. Suite content changes are versioned as immutable snapshots.

**Rubric / preference profile.** Distilled, source-traceable statements of what this workspace considers good work, maintained as governed knowledge records and updated only through knowledge proposals. Rubrics serve two consumers: the Judge as grading criteria and Workflow Coordinator decisions as authorized context material for future work. Rubric records must cite the feedback events they were distilled from.

**Outcome telemetry links.** References connecting each promoted change to downstream signals that arrive after promotion: user redo/refinement rates, review outcomes, skill version pin changes, and external outcome data where the workspace has it (for example ad performance metrics in a creative workspace). External ground truth validates or invalidates promotions over time; it does not gate them synchronously.

Shared-skill layering: workspace-local learning (rubrics, overlays, configuration) never mutates a shared Skill Catalog entry. A change graduates to the shared skill only when evidence spans multiple workspaces, and that graduation is itself a full-tier proposal.

### Evaluation Harness

The Harness is frozen with respect to any run it executes: harness version, suite snapshot id, model id, and budgets are recorded in every result and must not vary within a comparison.

Execution contract:

- Work/judge isolation: candidates run in standard worker sandboxes; acceptance checks and held-back assertions run in a separate ephemeral judge sandbox. Candidate workers must have no read path to acceptance checks, mirroring EdgeBench's two-container rule and OpenKit's existing sandbox boundaries.
- Fixed budgets: every `EvalTask` runs under its recorded budget. Results from different budgets are not comparable and must not be aggregated.
- Error continuation: a candidate error does not abort the task run. The Harness records the error, allows recovery within budget, and scores the full trajectory. Trajectories containing recovered errors are flagged for Reflector analysis.
- Trajectory scoring: where acceptance checks can be evaluated repeatedly, the Harness records score-at-checkpoint curves (per step or per submission), not only final scores. Between two candidates with equal endpoint quality, the faster-converging candidate wins.
- Mechanical metrics always recorded: steps, tokens, cost, wall clock, tool-error rate, permission denials, and gate hits. These are guard metrics for regression detection and budget control, never optimization targets by themselves.
- Every run produces an evidence bundle: per-task outcomes, curves, metrics, judge verdicts with rubric version, environment identifiers, and links to full trajectories.

### Judge convention

- Stateless: no memory across calls, no tools, no registered identity.
- Blind: candidates are presented in randomized order with neutral labels; the call context contains no proposer rationale, no version history, and no incumbent marker.
- Rubric-driven: the rubric snapshot id is recorded with every verdict.
- Model-diverse: the judge model should differ from the model that produced the proposal; when impossible, the deviation is recorded in the evidence bundle.
- Pairwise by default: absolute scoring is used only where a mechanical scale exists. Quality questions are asked as comparisons.
- Self-preference audit: periodically, known-identical candidate pairs are injected; a judge configuration that fails A/A consistency checks is flagged and its recent verdicts marked low-confidence.

### Improvement proposals

An `ImprovementProposal` record must carry:

- proposal id, workspace id, Reflector run reference
- target type: `skill-version`, `prompt-template`, `knowledge-rubric`, `suite-curation`, `coordinator-spec-draft`
- target reference and concrete diff or new version content
- motivating evidence: trajectory references, failure/recovery analysis, feedback events
- predicted effect stated before evaluation
- pinned evaluation environment: suite snapshot id, rubric snapshot id, model id, harness version
- evaluation results once run: regression gate outcome, pairwise verdicts, guard metrics
- lifecycle status: `draft`, `evaluating`, `rejected-mechanical`, `awaiting-review`, `approved`, `promoted`, `rolled-back`, `withdrawn`

Lifecycle rules:

- Mechanical gate first: a proposal that fails its pinned regression suite is auto-rejected and never surfaces for human review. Rejection is recorded with evidence for Reflector learning.
- Snapshot pinning: a proposal is always evaluated against the latest suite snapshot that predates the proposal's creation. Suite changes proposed by the Reflector can never apply to the Reflector's own in-flight proposals.
- Batch separation: suite-curation proposals and behavior-change proposals are never approved or promoted in the same batch.
- Tiered approval:
  - `knowledge-rubric` and `suite-curation`: lightweight review via the knowledge proposal path; auto-promotion may be enabled per workspace with visible history and one-step rollback.
  - `skill-version` and `prompt-template`: full Action Center approval with evidence bundle attached; promotion updates the catalog version without unpinning workspaces that pinned the previous version.
  - `coordinator-spec-draft`: never auto-applied; delivered as a draft document for the human spec workflow under `docs/change-tracking.md`.
- Post-promotion follow-up: promoted proposals keep their outcome telemetry links open; the Reflector must review them at the next reflection pass and may propose rollback.

### Trigger model

- Baseline: scheduled idle-time reflection passes via the durable scheduler (per-workspace cadence, default daily).
- Event triggers: a redo request, an explicit negative feedback event, a review rejection, or a new suite failure enqueues a targeted reflection for the affected thread.
- Budget cap: reflection and evaluation runs draw from a per-workspace self-improvement budget (tokens, sandbox hours). When exhausted, triggers queue rather than run.
- Manual trigger: users can request reflection on a thread or skill from product surfaces; this follows the same pipeline with no shortcuts.

### Evaluation tiers and frequency

| Tier | Scope | Budget scale | Frequency |
| --- | --- | --- | --- |
| Proposal gate | Workspace regression suite + pairwise judging | Minutes per task | Every proposal |
| Health sweep | Full suites + guard metric trends across workspaces | Batch, off-peak | Nightly/weekly schedule |
| Long-horizon stories | Day-scale L6 story acceptance scenarios exercising Goal Mode end to end | Hours per story | Per release |

Long-horizon evaluation belongs exclusively to the release tier and reuses the L6 model from `docs/specs/20260529-l6_story_acceptance.md`, extended with trajectory-curve reporting and error-continuation rules. Day-scale runs must not enter the proposal gate.

### Signals inventory

The loop consumes, in decreasing order of trust:

1. External outcome data linked by the workspace (highest trust, slowest, not always present)
2. Explicit human decisions: approvals, rejections, redo requests, review outcomes, skill version pinning
3. Implicit human behavior: steering frequency, refinement depth, abandonment
4. Mechanical trajectory metrics from the Harness
5. Judge verdicts (useful, but always the least-trusted signal and never sole promotion evidence for behavior changes)

### Goodhart and gaming guards

- Guard metrics ratchet (must not regress) but are never optimization objectives.
- Quality is only ever judged pairwise against rubrics; no composite quality score is defined or optimized.
- Suites rotate with fresh harvests from recent real failures to resist overfitting to a stale task distribution.
- Work/judge sandbox isolation removes the candidate's read path to acceptance checks.
- Snapshot pinning plus batch separation removes the Reflector's write path into its own evaluation.
- All Reflector, Harness, and Judge activity lands in audit under `docs/core/audit.md` categories.

## Resolved Design Questions

The following questions were raised during drafting and resolved by discussion. The shared reasoning: guarantee properties by mechanism rather than convention (pinning, quorum, additive-only diffs, TTL), and reuse existing primitives rather than inventing parallel ones (context packages, conflict detection, metering, backup scope).

### Suite storage location

`EvalTask` records and suite snapshots live in a dedicated evaluation area under the workspace data root, not inside the knowledge store. Evaluation data carries context snapshots and file fixtures, is immutable once snapshotted, and is consumed by Harness code — its lifecycle, consumers, and governance differ from OKF Markdown knowledge pages in every dimension, and forcing it into the knowledge store would contaminate the governance rules in `docs/specs/20260702-knowledge_store_governance_rules.md`. Rubrics remain knowledge records; `EvalTask` records reference them by id. The evaluation area is included in workspace backup/export scope under `docs/specs/20260704-workspace_backup_export_import.md`.

### Context snapshot fidelity

Replay freezes the worker context package, not the workspace. The context package is the source-traceable record of what the Coordinator semantically composed and the owning mode service materialized, making it the most faithful and cheapest replay unit. Tasks that need files get a minimal fixture materialized at harvest time from the files the original trajectory actually touched. Staleness is handled by retirement rather than synchronization: suite refresh detects fixture drift from current workspace reality and flags drifted tasks for replacement — consistent with the rotation rule that suites must be refreshed from recent real work anyway.

### Judge model routing

Judge model routing is a NanoCore-level default table with per-workspace override. Central ownership is required because the judge-differs-from-proposer constraint can only be reliably enforced centrally. The judge model is not pinned to rubric versions — rubrics evolve for content reasons unrelated to judging. The binding invariants are: the judge model stays constant within any one pairwise comparison series, and the model id is recorded in the evidence bundle of every run.

### Cross-workspace graduation

Graduation to a shared Skill Catalog entry requires shadow-evaluation replication. After a local promotion of a change to a shared skill, the Reflector schedules shadow evaluations on a sample of other workspaces using that skill — running their suites and rubrics without affecting production. A graduation proposal is generated only when the change wins in a quorum of sampled workspaces (default two-thirds) with zero regressions. Replication is the evidence threshold; the mechanism also structurally prevents one workspace's taste from generalizing into a shared default.

### Budget accounting

Self-improvement consumption is metered as a distinct category under `docs/core/metering.md`, with a per-workspace cap defaulting to a configurable fraction (10-20%) of regular workspace consumption. Separate metering is required both for trust — users must see what the loop costs versus what work costs — and because the trigger model's budget cap needs metering as its enforcement substrate. When the cap is reached, triggers queue rather than drop.

### Auto-promotion scope for knowledge-rubric proposals

Only strictly additive diffs are eligible for auto-promotion: proposals that add new rubric or lesson entries without modifying or removing any existing entry and without hitting Knowledge Manager conflict detection against user-stated preferences. Any mutative diff or conflict hit escalates to human review. Auto-promoted entries are marked provisional with a TTL: they become permanent when confirmed by a human or cited by a configured number of subsequent task runs, and expire otherwise. The worst-case outcome of auto-promotion is therefore a temporarily useless suggestion, never a durable corruption of the workspace preference profile.

## Follow-ups

- Promote the Task Evaluator placeholder resolution (Reflector + Harness + Judge) into the internal role table of `docs/core/architecture.md` once this spec is accepted.
- Skill Catalog versioning and pinning is specified as a Phase 2 prerequisite in `docs/specs/20260711-skill_catalog_versioning_pinning.md`.
- The trigger model's cadence and event-trigger mechanism is specified in `docs/specs/20260711-scheduler_recurring_event_triggers.md`; reflection cadences ride its recurring schedules and the event triggers named in this spec use its one-shot convention.
- Extend `docs/specs/20260529-l6_story_acceptance.md` with trajectory-curve reporting and error-continuation rules for the long-horizon tier.
- Define audit event categories for reflection runs, evaluation runs, judge verdicts, and promotions under `docs/core/audit.md`.

## External References

- karpathy/autoresearch — minimal artifact/harness/metric improvement loop; evaluator as frozen code. https://github.com/karpathy/autoresearch
- ByteDance Seed EdgeBench / SForge — long-horizon evaluation, error continuation, trajectory scoring, work/judge two-container isolation. https://github.com/ByteDance-Seed/EdgeBench
