# Engineering Doctrine

Status: Accepted

This document records why this repository works the way it does: the delegation premise, the role documents play, the verification philosophy, and the criteria under which the premise itself would be judged wrong. It is explanatory intent for agents and humans applying the normative rules elsewhere; it defines no behavioral contract, and no implementation choice may cite it as sole authority.

This document does not own product doctrine (`docs/core/foundation.md`), product purpose (`docs/product-vision.md`), the documentation type system (`docs/documentation-model.md`), or any repository execution rule (`AGENTS.md`, `docs/change-tracking.md`).

## The Premise Under Test

This repository is a deliberate experiment in full delegation: agents execute substantially all development and maintenance work, and engineers act as product owner and tech lead. The premise is that current agents can own a project of this shape — a core in the low hundreds of thousands of lines inside a repository under a million — provided the architecture stays modular and every module is independently verifiable. The binding constraint is not total size; it is the size of the largest unit that must be understood as a whole, the verifiability of each module, and the rate of semantic drift over time.

The premise is a hypothesis, not a settled conclusion. Its expected failure mode is not visible collapse but entropy: duplicated abstractions, tests that still pass while no longer testing intent, and specifications that drift from what was meant. The whole engineering system described below exists to make that entropy measurable.

## Documents As The Source Of Intent

Documents are the single source of truth for intent; running code is always the de facto source of truth for behavior. All engineering risk lives in the gap between them, so the regime never relies on prose staying true by discipline alone: normative statements degrade into executable projections — contract tests, schema checks, repository validators, story assertions — and independent audits measure the residual gap. A specification statement that nothing can check mechanically is where drift will accumulate; finding those statements is a standing task, not an incident.

Authority is inversely proportional to change rate. Core documents are stable and highest; specifications decide designs; change records carry execution context and never gain design authority; audit records are instrument readings and carry none. This ordering exists because authority attached to fast-moving documents would let the source of truth drift with execution.

Raw discussion — human or agent — is the execution log of thinking. It is not committed; what is committed is the distilled decision, its rationale, and its rejected alternatives, in the document type that owns them. The same selective-rehydration bar that governs document compression governs this distillation: nothing may be dropped whose absence would change a material choice.

## Verify The Verifiers

Under full delegation every verifier — test suite, reviewer, judge, auditor — is itself agent-produced, so verifier failures correlate with implementation failures, and any unmeasured verifier degrades silently. The human role therefore shifts from verifying the product to verifying the verifiers, and the empirical method for that is fault injection: feed a verifier known faults and read its detection rate. Detection-power trends, not anecdotes, are how this repository knows its delegation is holding.

Three consequences follow. Production and verification stay separated: whoever produced an artifact does not adjudicate it, and metrics measured by the audit side are never handed to implementers as optimization targets, because a targeted proxy stops measuring. Independence has three dimensions — context, model, and objective — and a verification design states which it actually provides. Loud failure beats quiet failure: a check that throws on the unknown is worth more than a tolerant one that silently passes what it does not understand.

Human attention is risk-tiered, not uniform: security, authorization, credentials, data loss, and irreversible external effects always warrant direct scrutiny; routine surfaces are sampled and reviewed through evidence, not diffs.

## The Human Role

Engineers own intent, architecture arbitration, and final approval — and final approval is based on evidence: calibration trends, audit findings, conformance results, and evidence packages, not line-by-line reading. Judgment is a maintained asset: periodic deep dives into real code and real failures are scheduled work, because the taste needed to smell a wrong architecture erodes without contact.

## Falsifiability

The delegation premise must remain falsifiable. The calibration program's owning specification defines concrete thresholds — detection rates on strict surfaces, review catch rates by defect class, specification load-bearing ratios — whose sustained violation triggers a scoping-down discussion rather than a rationalization. Evidence that the premise is failing is a finding, not an embarrassment; the experiment's value is the answer, in either direction.

## Related Docs

- `docs/product-vision.md`
- `docs/documentation-model.md`
- `docs/core/foundation.md`
- `docs/specs/20260719-verification_calibration.md`
