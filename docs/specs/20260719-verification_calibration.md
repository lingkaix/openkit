---
status: Accepted
kind: process
implementation: Not Started
aspect: process
---
# Verification Calibration Program

This specification owns repository verification calibration and task-external execution residue measurement.

## Scope

### Owns

- Repository verification calibration across three fault-injection layers (code mutation, seeded review and adjudication defects, and specification-derivation mutation), the shared fault taxonomy, the calibration record schema, and audit reporting in `docs/audits/`.
- Task-external execution residue measurement from evidence left by completed work: the audit-side trigger, comparable observations, record form, and separation from the measured work.
- Current repository engineering calibration scope, where strict surfaces derive from `docs/core/doctrine.md` and the root `AGENTS.md` Safety Kernel.

### Does Not Own

- The single-instrument discriminating-power record that admits one harness as an oracle; `docs/verification-instruments.md` Harness Admission owns it, and focused negative proof during work is not a calibration cycle.
- The L0-L6 test taxonomy and gate policy in `docs/specs/20260529-test_strategy.md`, and L6 story acceptance semantics, roles, and evidence packages in `docs/specs/20260529-l6_story_acceptance.md`.
- Active execution, coordination, gates, role composition, and stop decisions in `docs/change-execution.md` (which calibration neither authorizes nor replaces), or change-record and temporary-pilot evidence forms in `docs/documentation-model.md` and `docs/change-execution.md`.
- Product runtime behavior, the runtime self-improvement and evaluation loop in `docs/specs/20260909-personal_memory_and_knowledge_learning.md#reflection-and-improvement`, or product audit records in `docs/core/evidence.md`.
- Mutation tooling internals, CI job definitions, and reviewer prompt content owned by implementation slices under separate change plans; within this specification, fault-injection calibration with its Goodhart guards and execution residue measurement remain distinct measurement methods.

### Core

- `docs/core/doctrine.md`

## Roles

- The audit side exclusively owns calibration metrics, measurement, record production, and trend reporting.
- Builders MUST NOT adjudicate their own calibration outcomes.
- Calibration judges and reviewers run in clean contexts, and reviewer or judge model families SHOULD differ from the builder's on strict surfaces.
- In layer 2, an [Auditor](../roles/auditor.md) acts as the seed author while planted variants traverse standard adversarial review blind.
- Adjudication calibration depends on the L6 role separation and retained evidence in `docs/specs/20260529-l6_story_acceptance.md` as prerequisites rather than newly owned calibration mechanisms.
- In execution residue measurement, the reader is an auditor or another fresh context independent of the context that produced the measured artifacts.

## Steps And Gates

- Do not build a unified calibration platform, scheduler, or evidence store; the layers share only the fault taxonomy, record schema, and audit reporting.
- Calibration creates no ordinary-development gate, and no per-change mutation obligation is inferred from this program.
- No single cycle's numbers form a verdict; trends decide sustained violations while each threshold retains its stated observation window.
- Global scores and calibration metrics are diagnostic only and MUST NOT appear as builder targets, prompt content, or gates.

### Layer 1: Code Mutation

- Layer 1 measures L1 and L2 test detection power by planting syntactic code mutations and counting survivors.
- Cycles are sparse and audit-selected across changed code or strict-surface modules with no fixed execution cadence; a material change does not automatically trigger a mutation run.
- Required safety regressions and deliberate harness failure under `docs/verification-instruments.md` remain applicable independently of calibration.

### Layer 2: Seeded Defects

- Layer 2 measures review and adjudication catch rates on taxonomy-indexed defects planted in variants of real changes.
- Seeded defects, not self-report, measure review-layer calibration.
- Seeds exist only on designated sandbox branches, and zero seeded changes may reach an integration branch under any outcome.
- Every seed MUST be registered before planting.
- Optional intent-fidelity samples plant an omission or distortion between a retained source instruction and its recorded decision; the detector receives the genuine source and candidate record without the seed answer and infers no unavailable user intent.
- Adjudication calibration re-adjudicates retained L6 evidence packages with a second clean judge to measure agreement and uses tampered-evidence probes to measure judge discrimination.

### Layer 3: Specification Mutation

- Layer 3 is derivation-sensitivity analysis from normative documents to enforced projections; running checks against a mutated authoring document alone is not detection proof.
- Dynamic step: sample claimed projection pointers, invert the pointed-to projection, and confirm failure using layer-1 mechanics.
- Ablation step: for each sampled normative statement, ask whether removing it changes any derivation of implementation, tests, failure, recovery, ownership, or responsibility.
- Needed and enforced statements stay; needed but unenforced statements are projection gaps.
- Enforced but unneeded statements are over-constraints; unneeded and unenforced statements are deletion candidates.
- Rebuild reasoning is a weak oracle, so ablation informs an audit and never deletes a statement alone; every deletion still preserves criteria under root `AGENTS.md` DOC-015.
- L6 is opt-in, expensive, and bounded: story artifacts serve as traceability edges and story runs serve only as sparse confirmation rather than a general specification-mutation vehicle.

### Removal Evidence

- Removing a mechanism requires mutation or named failing-case sensitivity to the responsibility the mechanism carries; green checks alone prove nothing.
- Redundant within its declared scope: remove it.
- Still required by a contract: keep it.
- Uncovered or inconclusive experiment or oracle: no removal follows.
- Behavior change found: leave the refactor scope and return the question to the owner.
- Analyze mutually backing mechanisms together.
- An unused export or pure forwarding wrapper may rest on lighter evidence: consumer closure, real-caller checks, and focused checks.
- Security, durable recovery, and external-effect removal paths require direct evidence under their own failure conditions.
- Experiments MUST NOT remove production safety protections or fire an external effect twice through differential comparison.
- Import-graph unused-export tools may narrow an audit sample, but they neither prove complete consumer closure nor act as a gate or substitute.

### Documentation And Discovery Probes

- A rebuild probe gives a fresh-context agent the bounded subsystem documents and [admitted contract artifacts](../documentation-model.md#admitted-rebuild-corpus) without implementation source, allowing implementation in another language.
- The rebuild probe checks the resulting implementation with the subsystem's existing black-box conformance tests.
- A discovery probe gives an independent agent an ordinary task for already implemented behavior with normal repository navigation and no target hint.
- Prior exposure of the discovery agent to the answer invalidates any improvement proof.

### Falsification Thresholds

- The first two full cycles calibrate and review the provisional thresholds against baseline data; any revision is a change to this specification.
- Strict-surface mutation detection sustained below 80% across two consecutive cycles is a falsification trigger.
- Authority-boundary or acceptance-predicate seeded-defect catch rate below two thirds in any cycle is a falsification trigger.
- A declining load-bearing ratio across two consecutive quarterly maps on sampled Core and strict-surface specifications while specification count grows is a falsification trigger.
- Independent-judge agreement on re-adjudicated evidence packages below 90% is a falsification trigger.
- Any sustained violation triggers a recorded delegation-boundary scoping discussion without simultaneous threshold relaxation.

### Initial Pilots

- The initial layer-1 pilot samples one small strict-surface package, measures cost, and retains sampled-survivor dispositions before extending to strict NanoCore modules.
- The initial layer-3 static pilot is hand-run by an audit agent on one high-stakes specification and publishes the first load-bearing map.
- The initial layer-2 pilot follows L6 role separation in runner practice, planting three to five seeds in one cycle and recording the first judge-agreement rate.
- Two manual cycles precede any evidence-first decision on whether shared tooling is justified.
- Every pilot uses its own change plan; this specification alone authorizes no implementation.

## Evidence

- `docs/documentation-model.md` owns the audit-record document type, and calibration records obey `docs/audits/` rules.
- In layer 1, each sampled survivor is recorded as a detected gap, an evidence-backed equivalent, or unresolved, without forcing completion of unrelated production work.
- Sampled layer-1 runs report per-module detection trends to the audit side.
- Layer 2 reports a catch-rate matrix by defect class and reviewer configuration; blind classes drive reviewer prompt, context-discipline, or model-family corrections.
- Layer 2 records verify seed teardown and prove integration absence.
- In layer 3's static step, enumerate sampled normative statements and require each mutated sample to name a concrete L0 rule, L1/L2 test, story assertion, or audit projection pointer; absence of a pointer marks unverified surface.
- Layer 3 publishes a per-document load-bearing map using `enforced`, `story-covered`, `audit-only`, or `unverified` statement states as an audit record to direct later L2 and L0 work.
- Existing story `contracts` metadata supplies a mechanical derivation edge.
- Story deterministic assertions are named as a derivation target through story outcome predicates rather than a per-story executable runner.
- In a rebuild probe, every question or guess by the agent is recorded as a specification gap, and every normative statement unusable without source code is recorded as implementation coupling.
- The rebuild probe is sampled rather than run on every change and retains one dated audit record per run.
- Before a discovery probe, the auditor records the expected owner, legitimate entrypoint, and behavior proof.
- A discovery probe observes whether the agent finds the implementation, understands its bounds, and reuses it, retaining the model, tool, and context used for comparable runs.
- The shared fault taxonomy indexes the five decision classes for material concepts in root `AGENTS.md` plus layer-1 local syntactic fault classes; every planted fault and catch-rate cell names its class.
- Each calibration cycle retains one dated audit record linking this specification; ordinary task findings and focused negative checks do not each require an audit record.
- Each intervention entry records injection identity, location, and time, expected detector, actual detectors with latency, disposition, and links to affected change records and documents.
- Calibration records compare available trends with prior cycles while keeping raw per-attempt output in `temp/`.
- A second clean-context judge reproduces calibration verdicts using the recorded evidence alone.
- For execution residue readings, an independent second reader reproduces the mechanical observations without using the producer's completion report as the sole source.

## Execution Residue

- Engineers decide any framework correction through a separate approved governance change; residue measurement creates no authority for a response.
- No active execution event vocabulary, state file, workflow engine, dashboard, scheduler, live breaker, or role invocation is required solely for residue measurement.
- Residue readings never return rates, advice, scores, gates, pauses, or redirection to active primary, build, test, review, or consultation work.
- Do not revive the rejected active event-production controller or live stagnation breaker; active direction recovery stays with `docs/change-execution.md`.
- Legacy committed state files and findings reports remain admissible under their producing framework; additional historical counts are labeled legacy and impose no new execution requirements.
- New pilot corpora may use Git history, actual artifacts, append-only intent, rewritable checkpoints, raw transcripts, tool output, timing, and human decisions in uncommitted working space.
- Every reading names the exact evidence used, never invents omitted history or events from narrative summaries, and reports missing data as unavailable rather than zero.
- Separate direct counts and timings from evaluator judgment; label each interpretation as judgment and state the method for each measure.
- Define no targets or thresholds before repeated completed-work observations exist; the first reading establishes a baseline, and one task proves no universal pattern.
- For each completed task, report only the observation-panel measures supported by its named evidence:
  1. Time to first direct contact with the relevant runtime, artifact, or external system.
  2. Time to the first usable artifact and to final acceptance.
  3. Human interruptions, classified as factual requests or engineer-only decisions.
  4. Wrong-premise rework: time or attempts abandoned after evidence defeated the premise or proxy.
  5. Recovery latency after compaction, pause, failed direction, or environment loss.
  6. Coordination cost in role invocations, handoffs, repeated reports, or waits where retained evidence supports a count.
  7. Escaped defects discovered after artifact acceptance.
  8. Strict incidents under the root `AGENTS.md` Safety Kernel concern set.
  9. Final acceptance and unresolved residual risk.
- The engineer triggers a reading after a meaningful completed-work corpus or pilot set.
- The reader inspects direct Git state, artifacts, execution output, checkpoint and intent history, raw retained evidence, and human decisions.
- Compare only like-for-like evidence across readings; any proposed governance addition cites repeated failures and identifies the smallest intercepting mechanism.
- Each run produces one dated audit record under `docs/audits/` linking this specification and naming the corpus, observations, unavailable fields, and comparison limits.
- The residue audit record carries no execution authority, recommendation, automatic threshold, or live signal.
- Raw evidence obeys credential, confidentiality, retention, and publication owners; retain only necessary redacted reproducible observations in the audit record.
- Every published number MUST be reproducible from the named evidence.

## Implementation

- Boundary and ownership checks: `tests/verification-instruments-contract.test.mjs`.
- Story contract-reference validation: `scripts/validate-story-schema.mjs`, `scripts/lib/story-metadata.mjs`.

## Implementation Gaps

- Three-layer verification calibration, documentation and discovery probes, and task-external execution residue measurement - Not Started; no formal calibration cycle, probe runner, or nine-measure residue reading program is implemented - #372, #312

## Decisions

- [Documents Pass When A System Can Be Rebuilt From Them](../decisions/20260923-documentation_rebuild_test.md)
- [Reserved Audit Question Rulings](../decisions/20261031-reserved_audit_question_rulings.md)
