# Verification Calibration Program

Status: Draft
Implementation: Not Started

## Owns

This specification owns the repository's verification calibration program: the three fault-injection layers that measure detection power at the three engineering trust boundaries, the shared fault taxonomy, the calibration record schema, cadences, audit-side ownership and separation rules, Goodhart guards, the zero-merge seed invariant, and the falsification thresholds for the delegation premise.

## Does Not Own

- The L0-L6 test taxonomy and gate policy; `docs/specs/20260529-test_strategy.md` owns them.
- L6 story acceptance semantics, roles, and evidence packages; `docs/specs/20260529-l6_story_acceptance.md` owns them.
- The audit-record document type; `docs/documentation-model.md` owns it.
- The product's runtime self-improvement and evaluation loop; `docs/specs/20260710-self_improvement_evaluation_loop.md` owns it. This program calibrates repository engineering, not product runtime behavior, and product audit records under `docs/core/audit.md` are a different domain.
- Mutation tooling internals, CI job definitions, and reviewer prompt content; implementation slices own them under their own change plans.

## Core References

- `docs/engineering-doctrine.md`
- `docs/documentation-model.md`
- `docs/core/foundation.md`
- `docs/specs/20260529-test_strategy.md`

## Summary

Under full delegation every verifier — test suite, reviewer, judge, auditor — is agent-produced, so verifier failures correlate with implementation failures and unmeasured verifiers degrade silently. This program answers one question empirically: if a known fault were planted at this trust boundary, which layer would detect it, how fast, and with what probability? Detection-power trends are the repository's health metric and the delegation experiment's falsifiability evidence.

The program has three layers matching three trust boundaries: code mutation calibrates the test suites, seeded defects calibrate the review and adjudication pipeline, and specification mutation calibrates the documentation-to-projection derivation chain. Mechanics stay distributed under existing owners; the layers share one fault taxonomy, one calibration record schema, and one reporting plane in `docs/audits/`.

## Current Scope

The program covers this repository's engineering system at its current shape: one TypeScript monorepo, vitest and node:test suites, the existing L0 validators, agent-executed changes under the root `AGENTS.md` rules, and a small team. Strict surfaces are those named by `docs/core/foundation.md` and the root rules: security, authorization, credentials, sandbox containment, data loss, durable authority, and irreversible external effects.

## Goals

- Measure, per trust boundary, the probability and latency of detecting a known planted fault.
- Convert unverified specification surface into named, enforced projections.
- Keep every calibration metric owned by the audit side and out of implementer optimization loops.
- Produce dated, comparable trend records that let a human approve work on evidence.

## Non-goals

- Do not build a unified calibration platform, scheduler, or evidence store.
- Do not gate ordinary development on global mutation scores or catch rates.
- Do not calibrate product runtime behavior; the product evaluation loop owns that.
- Do not treat any single cycle's numbers as a verdict; trends decide.

## Layer 1: Code Mutation

Code mutation calibrates the L1/L2 test suites by planting syntactic faults and counting survivors.

Per material change touching a strict surface, an incremental mutation run covers only the changed code. Every surviving mutant is either killed by a new test or given an equivalence argument; the disposition list enters the change's evidence in its change record. This diff-level killed-or-justified rule is the only mutation gate. Triage effort per change is bounded; an exhausted budget is recorded, not silently absorbed.

Periodically, a sampled full run covers strict-surface modules and reports per-module detection trends to the audit side. Global scores are diagnostic only and MUST NOT appear as implementer targets, prompts, or gates.

## Layer 2: Seeded Defects

Seeded defects calibrate the review and adjudication pipeline by measuring its catch rate against known planted defects.

A saboteur agent derives variants of real changes with planted defects indexed by the shared fault taxonomy, and the variants pass through the standard adversarial review blind. The output is a catch-rate matrix by defect class and reviewer configuration; a blind class drives reviewer prompt, context-discipline, or model-family changes.

The zero-merge invariant is strict: seeds exist only on designated sandbox branches, every seed is registered before planting, teardown is verified, and no seeded change may reach an integration branch under any outcome.

The same layer calibrates adjudication: re-adjudicating retained L6 evidence packages with a second clean judge yields an agreement rate, and tampered-evidence probes measure judge discrimination. This depends on the L6 role separation and evidence retention already specified in `docs/specs/20260529-l6_story_acceptance.md`.

## Layer 3: Specification Mutation

Specification mutation calibrates the derivation chain from normative documents to enforced projections. Documents are authoring-time sources, not runtime inputs, so running checks against a mutated document proves nothing; the method is derivation-sensitivity analysis.

Static step: for a sampled document, enumerate its normative statements and, for a mutated sample of them, demand a concrete pointer to the projection that would have to change — an L0 rule, an L1/L2 test, a story assertion, or an audit rule. A statement with no pointer is unverified surface.

Dynamic step: for a sample of claimed pointers, invert the pointed-to projection and confirm it fails, reusing layer 1 mechanics as the proof.

The output is a load-bearing map per document — enforced, story-covered, audit-only, or unverified per statement — published as an audit record, and it drives where the next L2 tests and L0 rules are added. Existing mechanical edges are story `contracts` metadata and story deterministic assertions; a citation convention linking L2 contract tests to their owning specification remains a proposed follow-up and is not authorized while this specification is Draft.

## Shared Fault Taxonomy

Defect classes are indexed to the five decision classes for material concepts in the root `AGENTS.md`: wrong definition or exclusion, authority or projection-boundary violation, lifecycle violation, wrong conflict or failure semantics, and missing or wrong acceptance predicate — plus local syntactic fault classes for layer 1. Every planted fault and every catch-rate cell names its class so results are comparable across layers.

## Calibration Records

Every calibration action produces one record with: what was injected, where, when, the expected detector, the actual detectors with detection latency, the disposition, and links to the affected change records and documents. Records are audit records under `docs/audits/` and follow that type's rules. Each cycle ends with one trend report comparing the cycle's rates to prior cycles.

## Ownership And Separation

The audit side owns all measurement, record production, and trend reporting. Production and verification stay separated: implementing agents never adjudicate their own calibration outcomes, calibration judges and reviewers run in clean contexts, and reviewer or judge model families SHOULD differ from the implementer's on strict surfaces. Calibration of the review layer itself is measured by seeded defects, not by self-report.

## Falsification Thresholds

The following provisional thresholds operationalize the falsifiability commitment in `docs/engineering-doctrine.md`; the first two full cycles calibrate them and their revision is a change to this specification.

- Strict-surface mutation detection sustained below 80 percent across two consecutive cycles.
- Authority-boundary or acceptance-predicate seeded-defect catch rate below two thirds in any cycle.
- Load-bearing ratio of sampled core and strict-surface specifications declining across two consecutive quarterly maps while specification count grows.
- Independent-judge agreement on re-adjudicated evidence packages below 90 percent.

Any sustained violation triggers a recorded scoping-down discussion of the delegation boundary, not a threshold adjustment in the same breath.

## Rollout

1. Layer 1 pilot on one small strict-surface package, proving cost and the killed-or-justified evidence flow; then extend to strict NanoCore modules.
2. Layer 3 static pilot on one high-stakes specification, hand-run by an audit agent, publishing the first load-bearing map.
3. Layer 2 pilot after L6 role separation lands in runner practice: three to five seeds in one cycle plus the first judge agreement rate.
4. After two manual cycles, decide per the evidence-first rule whether any shared tooling is justified.

Each pilot runs under its own change plan; this specification authorizes no implementation by itself.

## Acceptance Predicates

- No calibration metric appears as an implementer target, prompt content, or gate, except the diff-level killed-or-justified rule.
- Every planted seed is registered, torn down, and provably absent from integration branches.
- Every calibration output is a dated audit record linking this specification.
- A second clean-context judge reproduces calibration verdicts from the recorded evidence alone.
- Thresholds are reviewed against baseline data after two cycles, as a change to this specification.

## Alternatives Considered

### One Unified Calibration Platform

Rejected: a single scheduler and store would be a new platform with correlated failure across all three layers, against the root anti-platform rules; the layers share taxonomy, record schema, and reporting instead.

### Implementer-Owned Metrics

Rejected: any measured proxy handed to its producer as a target stops measuring; audit-side ownership is the Goodhart guard.

### Running Checks Against Mutated Documents

Rejected: L0-L5 checks and L6 assertions are authoring-time projections that do not read documents at run time, so verdicts cannot flip; derivation-sensitivity analysis replaces it.

### L6 As The Specification-Mutation Vehicle

Rejected as a general mechanism: L6 is opt-in, expensive, and bounded by its own specification. Story artifacts serve as traceability edges, and story runs serve only as sparse confirmation.

## Deferred, Non-authorizing Questions

- Whether calibration runs deserve scheduled automation after two manual cycles.
- Whether reviewer and judge model rotation should follow a standing policy.
- Whether the load-bearing map should extend beyond core and strict-surface specifications.

## Related Docs

- `docs/engineering-doctrine.md`
- `docs/documentation-model.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/specs/20260529-l6_story_acceptance.md`
- `docs/specs/20260710-self_improvement_evaluation_loop.md`
- `docs/audits/README.md`
