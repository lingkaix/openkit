---
type: change-plan
status: planned
date: "2026-09-24"
---
# Documentation Normalization

## Intent Revision 1 — 2026-09-24

On 2026-09-24 the engineer accepted that documents are the project's primary source of truth and are built and governed like code: organized by concept with progressive disclosure, one fact in one place, normative text free of implementation identifiers, and specifications that declare a kind with mechanism specifications owning questions and a member registry. [Engineering Governance Landing](../202609231611190001-engineering_governance_landing/plan.md) landed those rules and drafted this plan to bring existing documents into line. The outcome is a specification corpus in which each oversized document has had a split review, normative text states rules in domain terms with navigation pointers moved to marked implementation sections, Amendment sections are merged into their bodies, mechanism specifications are in question-and-registry form, and every kind classification has been confirmed. The engineer transfers this plan to a primary before work starts. docs/product-vision.md is out of scope. No commit, push, deployment, or external publication is authorized by this draft.

## Owners

[Documentation Model](../../documentation-model.md) owns document types, kinds, and the placement rule. [Documentation Writing](../../writing.md) owns the writing rules and the split-review trigger. The [specifications README](../../specs/README.md) owns body guidance, including the Current Implementation Projection section. [Verification Calibration](../../specs/20260719-verification_calibration.md) owns document mutation, document ablation, and the rebuild probe. Each specification remains the owner of its own criteria; this plan changes their form, never their decisions.

## Accepted Decisions

- [Documents Are Built And Governed Like Code](../../decisions/20260924-documentation_methods.md).
- [Specifications Declare A Kind And Are Divided At Promotion](../../decisions/20260923-specification_kinds_and_promotion.md).
- [Documents Pass When A System Can Be Rebuilt From Them](../../decisions/20260923-documentation_rebuild_test.md).

## Working Checkpoint

Status is planned. Facts measured on 2026-09-24: 31 specifications exceed about 6,000 words, the largest docs/specs/20260802-nanohost_runtime_and_transport.md at 51,231 words; 96 file-and-line citations appear in 7 specifications; 5 specifications keep an Amendment section; 13 specifications declare the mechanism kind; the 90 kind values were first classified by a compiler agent and several were low-confidence, with the classification kept under temp/changes/202609231611190001-engineering_governance_landing/compile/. Risk: every earlier relocation in this repository lost qualifiers in connective sentences while validators stayed green.

Method: one specification per slice, each its own reviewable change. The writer lists every criterion moved, merged, or reworded with old and new location; a separate context checks the diff against that list and the old text under DOC-015. Start with the cheapest slices that also test the method: confirm low-confidence kinds, then remove line citations from one specification, then merge one Amendment section. Split reviews start with the largest document, and a split review may conclude that a document stays whole. Mechanism conversion moves concept-specific semantics into the concept's specification only when the receiving owner accepts it.

Predicted Next Action: confirm the low-confidence kinds with a reviewer and correct them. Expected observable: validators pass and every changed kind has a reason. Evidence that would change the route: a criterion-preservation check that finds a lost qualifier, which stops the slice and shrinks the next one.

## Verification Direction

Run the documentation-model, specification-lifecycle, and index checks after each slice. The deciding evidence is the independent criterion-preservation check, not validator output. After the first split, run one rebuild probe on the split concept as defined by the verification calibration specification, and compare it with the same probe on the pre-split text.
