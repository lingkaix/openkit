---
type: change-plan
status: in-progress
---
# Claim And Observation Notebook Authority

## Intent Revision 1

The coordinator approved C01/C02 as the second of three separate reset-cohort increments on 2026-10-19. Claims and reusable Observation/conflict analysis use one governed OKF notebook authority and the Knowledge Manager; the separate canonical JSONL families end. Prepare final retained shapes, writers and validators first, and report a pushed candidate for the joint shape review. Land only after the coordinator announces the pre-reset cut and main is green. Do not convert old data, add a legacy reader or dual writes, perform a reset, or edit Web code.

## Owners

[Information consolidation](../../specs/20261018-nanocore_interception_and_information_consolidation.md#information-and-record-authority), [Knowledge governance](../../specs/20260702-knowledge_store_governance_rules.md), and [Notebook editing](../../specs/20260909-knowledge_notebook_editing.md) own the accepted lifecycle. Ordinary scoped publication, current admission, fixed bases, Review, Audit and restart remain authoritative. This plan grants no new authority.

## Proposed Fields And Ablation

- Claim `confidence` is a finite numeric value from zero through one. Without it, the accepted numeric assessment is lost or becomes unvalidated prose; it never grants authority. Observation confidence is optional and uses the same rule when present.
- `conflict_status` states the existing Claim uncertainty or structured Observation conflict state. Without it, the existing publication and retrieval conflict predicates cannot be preserved.
- Conflict Observation `subject_refs` identifies the affected objects independently of supporting `source_refs`. Without it, unrelated conflicts can block publication or relevant conflicts can escape. Structural collection validation and current reference-owner resolution are separate responsibilities.

The common type, body, scope, source, freshness, review and attribution fields remain with their existing owners. Unknown descriptive extensions remain inert. No second fact identifier, store, assessment runner or resolution ledger is introduced.

## Checkpoint

The candidate starts from Server main29258b5a. C05/C04 owns shared validator paths until explicit release; its branch will be merged normally. L-ID owns active marker/reference joins in the Store and file records, and L-AW owns portability integration. Those seams are not writable here before handback. The first regression run observed14 expected validation failures and4 valid passes after dependency setup; no ledger reader or writer has changed. The empty/nested-array parameter rows were then corrected to pass the entire collection to the oracle. C05/C04 a60e3404b was merged normally after its writer released the paths. For real URI validation, the approved L-ID Protocol codec3cafc7ab was also merged normally for preparation; this branch cannot land those dependencies before their owning lane lands them on main. The intended red result is acceptance of missing or invalid numeric confidence and structured conflict metadata by the current generic validator. Setup failure will not count as that red result.

## Remaining Joins

The subject collection uses the real L-ID ReferenceUriSchema and formatter, with no temporary parser. Native target admission and the full KB/reference producer joins remain dependencies; syntax validation supplies no target access. Move both the Proposal guard and retrieval exclusion to published conflict Observations while preserving their distinct status predicates. Retire old operation and portable-ledger consumers in the same completed increment. Keep operational WorkObservation, Audit, actual decisions and User suppression unchanged. The exact unresolved-conflict removal rule requires owner clarification before that dependent lifecycle path changes; it does not block field validation.

## Verification

Derive field checks from the accepted contract, then exercise actual notebook publication, citations, current Source admission, conflict refusal/resolution, stale-base behavior and restart. Run complete affected module directories and shared inventories, obtain independent Sol review, and retain exact logs. This candidate is not yet a completed cutover or a passing feature gate.

Focused validation passed140 cases across the complete new Claim/Observation and typed-page files plus both existing OKF files in1.64 seconds. The Protocol build and Biome check passed. Evidence: `temp/changes/202610181600000001-claim_observation_okf/shape-green.log`. This is shape evidence; complete-module gates and native authority joins remain pending.
