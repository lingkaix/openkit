# Documentation Model And Calibration Foundations

Type: change-plan

Status: verified

Started: 2026-07-19

Completed: 2026-07-19

Branch: `codex/self-improvement-loop-foundations`

## Intent

Give the documentation-as-SSOT regime its missing governance layer and open the verification calibration program: a closed documentation type system with a generated index and mechanical validation, an engineering doctrine document that records the delegation premise and its falsifiability, a new audit-record type for instrument readings, and the Draft specification for the three-layer fault-injection calibration program.

## Motivating Findings

- The documentation type set had no owner: `docs/working_logs/` was removed as a type, yet eight references in `docs/change-tracking.md`, two in `AGENTS.md`, and residuals in `docs/template-overview.md`, `CONTRIBUTING.md`, and `docs/app-api.md` continued instructing agents to archive into a directory that no longer exists. Type-set changes rot invisibly when governance content lives inside a high-frequency execution document.
- `docs/change-tracking.md` had drifted beyond its design intent as the change-record execution rulebook, accumulating a partial directory taxonomy because no taxonomy owner existed.
- The engineering premises of this repository — full delegation, documents as intent SSOT, verification philosophy, falsification criteria — lived in discussion history and human memory, unreadable by the agents expected to apply them.
- Calibration outputs (load-bearing maps, detection-rate trends, catch-rate matrices) had no home type: they are dated observations, not decisions, and fit neither specs nor change records.

## Decisions

1. `docs/documentation-model.md` owns the closed documentation type system, authority precedence, reading protocol, cross-reference rules, index contract, and amendment procedure. Adding a type requires amending it first.
2. `docs/change-tracking.md` contracts back to change-record execution rules; its directory-ownership content reduces to a pointer, and all `working_logs` semantics are removed repo-wide. Long-run release flow keeps high-signal context in change records and leaves noisy run files in uncommitted working space.
3. `docs/engineering-doctrine.md` records the delegation premise, the docs-as-SSOT rationale, the verify-the-verifiers philosophy, the human role, and the falsifiability principle. It is explanatory intent, not behavioral contract, and is deliberately distinct from `docs/core/foundation.md`, which owns product-runtime doctrine.
4. `docs/audits/` is a new subordinate document type: dated, rule-generated observation records with no authority, never edited after the fact, each linking its generating specification.
5. `docs/specs/20260719-verification_calibration.md` opens as a Draft specification owning the three-layer calibration program: code mutation calibrating test suites, seeded defects calibrating review and adjudication, and specification mutation calibrating the docs-to-projection derivation chain, unified by one fault taxonomy, one calibration record schema, and audit-side ownership.
6. The index is a generated projection: `scripts/generate-doc-index.mjs` produces `docs/INDEX.md`, `scripts/validate-doc-model.mjs` enforces closed-set membership plus change-record and audit-record rules, and `check:repo` runs both with a regeneration drift check, mirroring the OpenAPI projection discipline.

## Scope

Documentation: the two new root documents, the change-tracking contraction, stale-reference cleanup in `AGENTS.md`, `docs/template-overview.md`, `CONTRIBUTING.md`, and `docs/app-api.md`, the `docs/audits/` README and AGENTS files, and the Draft calibration specification. Code, test-first: the doc-model validator, the index generator with `--check` drift mode, their tests, `docs/INDEX.md` generation, and `check:repo` wiring.

## Non-Goals

- No implementation of the calibration layers themselves; the Draft specification authorizes design discussion, and execution begins under its own change plan after acceptance.
- No new platform: the validator and generator follow the existing `validate-spec-lifecycle.mjs` pattern as thin scripts over the committed corpus.
- No retroactive rewriting of existing change records or terminal specs; the model governs from now forward.
- No change to product behavior, protocol, or public API.

## Design Ownership

- [Documentation Model](../documentation-model.md) owns the type system this change introduces.
- [Change Tracking](../change-tracking.md) retains change-record execution rules.
- [Engineering Doctrine](../engineering-doctrine.md) owns the recorded premises; [Product Vision](../product-vision.md) and [Foundation](../core/foundation.md) remain unchanged product-side owners.
- [Verification Calibration](../specs/20260719-verification_calibration.md) (Draft) owns the calibration program design.
- [L6 Story Acceptance](../specs/20260529-l6_story_acceptance.md) and [Test Strategy](../specs/20260529-test_strategy.md) are unchanged and referenced.

## Execution Plan

1. Land `docs/documentation-model.md` and this record.
2. Land `docs/engineering-doctrine.md`.
3. Contract `docs/change-tracking.md`; clean stale `working_logs` references repo-wide.
4. Create `docs/audits/` with README and AGENTS.
5. Land the Draft calibration specification.
6. Tests first, then `scripts/validate-doc-model.mjs` and `scripts/generate-doc-index.mjs`, generate `docs/INDEX.md`, wire `check:repo`.
7. Full verification; complete this record.

## Verification Plan

- `node --test` doc-model tests pass, with new tests observed failing before implementation.
- `node scripts/validate-doc-model.mjs`, `node scripts/generate-doc-index.mjs --check`, `node scripts/validate-story-schema.mjs`, and `node scripts/validate-spec-lifecycle.mjs` all pass on the committed corpus.
- No `working_logs` reference remains outside historical change records and terminal specs.
- The Draft specification passes spec lifecycle validation.

## Checkpoints

- 2026-07-19: Documentation model accepted and landed; change plan opened.
- 2026-07-19: Doctrine, change-tracking contraction, repo-wide `working_logs` cleanup, `docs/audits/` guides, and the Draft calibration specification landed.
- 2026-07-19: Validator, index generator with `--check`, tests, generated `docs/INDEX.md`, and `check:repo` wiring landed. The change-record link rule was widened during survey to accept sibling `](./...)` links after two existing records showed that style, so no legacy inventory was needed.

## Implementation Summary

Implemented and verified. `docs/documentation-model.md` owns the closed type system; `docs/engineering-doctrine.md` records the premises; `docs/change-tracking.md` is contracted to change-record execution rules; `docs/audits/` exists with local guides; `docs/specs/20260719-verification_calibration.md` is a Draft awaiting acceptance; `scripts/validate-doc-model.mjs` and `scripts/generate-doc-index.mjs` enforce membership, record rules, and index freshness inside `check:repo`, with classification owned by the validator and consumed by the generator.

## Final Verification

- `node scripts/validate-spec-lifecycle.mjs`, `node scripts/validate-story-schema.mjs`, `node scripts/validate-doc-model.mjs` (199 documents, zero unknown), and `node scripts/generate-doc-index.mjs --check` all pass on the committed corpus.
- `node --test tests/doc-model.test.mjs tests/story-runner/story-metadata.test.mjs` passes 29 tests, including committed-corpus validation, fixture negative cases for unknown types, malformed change records, unlinked records, orphan audit records, and index drift detection. Tests were authored before the implementation.
- No `working_logs` reference remains outside historical change records and the deliberate removal note in `docs/documentation-model.md`.
- Changed source lines respect the Biome 100-column format; the platform Biome binary was unavailable in the verification sandbox.

## Remaining Follow-Ups

- Rerun `pnpm run check:repo` in an environment with the platform Biome binary before commit.
- Accept or revise `docs/specs/20260719-verification_calibration.md` from Draft, then open the layer 1 pilot change plan per its rollout section.
- Add the L2 contract-test-to-owning-spec citation convention authorized by the calibration specification.
