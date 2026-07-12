# Spec Lifecycle Governance And Repository-Wide Reclassification

Type: change-plan
Status: verified

## Intent

Make specification authority mechanically clear by aligning every spec's status, implementation alignment, location, lifecycle evidence, and current-guidance links with one canonical lifecycle model.

## Scope

- Make `docs/specs/README.md` the single source of truth for spec status values, implementation values, lifecycle transitions, required evidence, and archive-directory semantics.
- Keep active `Draft`, `Accepted`, and `Deprecated` specs at the root of `docs/specs/`.
- Use `docs/specs/superseded/` for contracts or substantive proposals continued or absorbed by named current guidance.
- Use `docs/specs/retired/` for contracts, modules, capabilities, or product directions that ended without successor contracts, including deliberate resets.
- Use `docs/specs/rejected/` only if the audit finds a proposal that was explicitly declined before acceptance and is worth retaining.
- Audit every active and archived spec against current core guidance, active specs, implementation evidence, change records, commits, and repository history where needed.
- Correct every spec's exact `Status` and `Implementation` values and applicable lifecycle metadata; correct every archived spec's directory placement, current-guidance value, lifecycle date, lifecycle reason, decision evidence, and retention reason.
- Update indexes and all material inbound and outbound links after moving files.
- Add a dependency-free repository check that rejects invalid values, invalid status/location combinations, missing terminal metadata, missing evidence sections, and broken local lifecycle links.

## Non-Goals

- Do not rewrite sound design content merely to normalize metadata.
- Do not mechanically swap the current `retired/` and `superseded/` trees without document-level evidence.
- Do not invent lifecycle reasons, transition dates, replacement links, or decision evidence when the repository cannot support them.
- Do not preserve the current inverted directory meanings for compatibility; OpenKit is in internal development and the clean lifecycle model wins.
- Do not introduce YAML front matter, a metadata database, a documentation framework, or a new dependency.
- Do not use lifecycle cleanup to change product behavior, implementation contracts, or unrelated core architecture.

## Related Context

- [Architecture](../core/architecture.md)
- [Work Model](../core/work-model.md)
- [Product Vision](../product-vision.md)
- [Change Tracking](../change-tracking.md)
- [Specification Guide](../specs/README.md)
- [Specification Agent Rules](../specs/AGENTS.md)
- [Prior Spec Inventory And Release Triage](../specs/retired/20260628-spec_inventory_release_triage.md)

## Impacted Surfaces

- Specification governance and templates under `docs/specs/`.
- Archived spec directory placement, metadata, reasons, and links under `docs/specs/superseded/`, `docs/specs/retired/`, and any evidence-backed future `docs/specs/rejected/` directory.
- Core-document entry guidance that distinguishes current specs from archived history.
- The material lifecycle record in `docs/changes/`.
- The repository-check command and its dependency-free lifecycle validator added in Phase 1.
- No product runtime, public API, protocol, storage, or Web behavior.

## Current Evidence Baseline

The baseline was measured from the current worktree on 2026-07-11.

- The active spec root contains 60 actual specs: 56 `Accepted` and 4 `Draft`.
- The archive contains 55 actual specs: 34 under `retired/` and 21 under `superseded/`; all currently use `Status: Superseded` regardless of their real lifecycle.
- The current rules define `retired/` as consolidated replacement detail and `superseded/` as discarded historical product direction, which is inverted relative to the agreed lifecycle meanings.
- The `superseded/web-ui-pre-rebuild/` group describes a removed or deliberately reset Web UI contract and is therefore a concrete `Retired` candidate rather than evidence of contract continuity.
- Much of the current `retired/` tree links to consolidated active specs or stable core guidance and is therefore a concrete `Superseded` candidate.
- Thirty of the 34 current retired specs use one of two generic retention phrases; those phrases do not establish why the old contract lost authority.
- `docs/specs/20260710-self_improvement_evaluation_loop.md` uses the invalid value `Implementation: Not started`.
- `docs/specs/20260629-openkit_policy_model.md` uses the non-enum value `Implementation: Standard-aligned subset`.
- The repository's current `check:repo` command does not validate spec metadata or lifecycle links.

## Required Invariants

- `Status` describes document authority; `Implementation` describes current implementation alignment. Neither substitutes for the other.
- Every spec has exactly one allowed `Status` and one allowed `Implementation` value with canonical capitalization.
- Root-level current specs use only `Draft`, `Accepted`, or `Deprecated`.
- Archived specs use the status matching their directory and terminal specs use `Implementation: N/A`.
- `Superseded` always identifies a current authority that actually continues or absorbs the old contract or substantive proposal.
- `Retired` always means that the old contract ended without a successor contract; related clean-slate work is not mislabeled as a replacement.
- `Rejected` always means that the proposal never became current guidance.
- Every non-active or restricted-authority transition has a trustworthy lifecycle date, current-guidance value, decision evidence, and substantive lifecycle reason; every archived terminal spec also has a substantive retention reason.
- A generic historical-context sentence never satisfies lifecycle evidence requirements.
- No active document uses an archived spec as its primary current-guidance entry point.
- File moves preserve repository-relative links or update every material reference in the same reviewed slice.

## Classification Rules

For each spec, answer these questions in order:

1. Is the document still intended to guide current design or implementation? If yes, keep it at the root and classify it as `Draft`, `Accepted`, or `Deprecated` according to its authority.
2. If it is no longer active, did another named authority continue or absorb its contract or substantive proposal? If yes, classify it as `Superseded` and place it under `superseded/`.
3. If no authority continues the contract, was the contract, module, capability, or product direction once active and later ended or reset? If yes, classify it as `Retired` and place it under `retired/`.
4. If the proposal never became current guidance because it was explicitly declined, classify it as `Rejected` and create `rejected/` only when the first verified case exists.
5. If evidence cannot answer the questions, do not guess or move the file; record the evidence gap as a checkpoint and resolve it before final verification.

## Execution Plan

### Phase 0: Canonical Rules And Reproducible Inventory

- Establish the agreed status definitions, transition rules, directory semantics, lifecycle metadata, evidence requirements, and reason-quality rules in `docs/specs/README.md`.
- Keep `docs/specs/AGENTS.md` focused on execution constraints and point it to the README enums instead of maintaining a duplicate status definition.
- Record the current active/archive counts, invalid field values, inverted directory semantics, generic-reason patterns, and missing validation gate.

Exit criteria: one canonical lifecycle model exists, the baseline is reproducible, and the full migration is captured by this change plan.

### Phase 1: Test-First Lifecycle Validator

- Add one focused test fixture set covering valid active, deprecated, superseded, retired, and rejected documents plus invalid values, casing, location, metadata, evidence sections, and local links.
- Add the smallest dependency-free Node validator that satisfies those tests.
- Treat only date-prefixed spec files matching `docs/specs/**/20*.md` as lifecycle documents; exclude directory `README.md` guides and local `AGENTS.md` rules from spec metadata validation.
- Wire the validator into `check:repo` so future drift cannot land after the migration.
- Allow only an explicit temporary inventory file owned by this change plan if the validator must land before all legacy documents are corrected; remove that inventory before final verification.

Exit criteria: a failing test demonstrates each guarded rule, the validator passes the corrected fixtures, and repository checks expose every remaining legacy violation.

### Phase 2: Active Spec Audit

- Audit all 60 root specs for exact status and implementation values, design authority, blocking open questions, implementation projection, and current links.
- Correct the two known implementation-value violations and any additional non-enum or duplicate metadata.
- Reclassify stale root specs only when current guidance and decision evidence prove that they are no longer active.

Exit criteria: every root spec has canonical metadata and is genuinely current as `Draft`, `Accepted`, or `Deprecated`.

### Phase 3: Archived Spec Evidence And Reclassification

- Review archived specs in cohesive ownership groups rather than applying a global directory rename.
- For current `retired/` groups whose contracts were consolidated into active specs or core guidance, record the real absorption reason and move them to `superseded/`.
- For current `superseded/` groups whose modules or product directions were removed or reset without contract continuity, record the real termination reason and move them to `retired/`.
- Identify any genuinely rejected proposal; create `rejected/` only for verified cases.
- For every archived spec, add terminal metadata, decision evidence, a substantive lifecycle reason, and a distinct retention reason.
- Preserve useful historical detail while stating which old constraints are invalid and which remain safe only as background.

Exit criteria: all 55 archived specs have evidence-backed status, location, current-guidance semantics, and reasons; no generic placeholder is treated as sufficient evidence.

### Phase 4: Link And Index Repair

- Update `docs/specs/README.md`, directory READMEs, active specs, core docs, change records, cookbooks, and other material references affected by file moves.
- Ensure active entry points lead to current root specs or stable core guidance before historical references.
- Remove or update the prior triage inventory once this plan becomes the canonical lifecycle record.

Exit criteria: all repository-relative links resolve, current entry points avoid archived authority, and directory documentation matches the final tree.

### Phase 5: Final Audit And Verification

- Run the lifecycle validator against the complete spec tree with no temporary exceptions.
- Recount statuses and directories and review every terminal document for evidence quality.
- Search for old paths, invalid values, generic placeholder reasons, and active links that treat archived documents as current guidance.
- Run repository documentation checks and close this record with the final classification summary, verification evidence, commit links, and any explicitly deferred evidence gaps.

Exit criteria: the complete tree satisfies the canonical lifecycle rules and future invalid metadata fails repository checks.

## Verification Plan

- Focused lifecycle-validator tests.
- `CI=true pnpm run check:repo`
- `git diff --check`
- Exact status and implementation-value inventory over date-prefixed `docs/specs/**/20*.md` files.
- Status-to-directory consistency check.
- Required lifecycle metadata and reason-section check for every `Deprecated`, `Superseded`, `Retired`, and `Rejected` spec.
- Repository-relative link existence check after every movement slice.
- Targeted search proving that active docs do not use archived specs as current guidance.

## Commit And Review Discipline

- Keep the rule and change-plan documentation in one scoped documentation commit.
- Land validator tests before validator implementation.
- Move and correct specs in cohesive ownership batches so each commit has reviewable lifecycle evidence.
- Do not mix unrelated implementation work already present in the worktree into this change.
- Review each batch for status correctness, evidence credibility, link integrity, and accidental design rewrites before proceeding.

## Expected Handoffs

- Human review of ambiguous cases where repository evidence supports more than one lifecycle interpretation.
- Focused implementation review when the validator and repository-check integration are added.
- Final human approval of the completed classification ledger before this record moves to `verified`.

## Risks And Mitigations

- Risk: mechanically swapping directories preserves incorrect classifications. Mitigation: classify each cohesive group from contract continuity and decision evidence before moving it.
- Risk: agents fabricate plausible but false retirement reasons. Mitigation: require linked decision evidence and leave unresolved files unmoved until evidence is found.
- Risk: file moves break many historical links. Mitigation: move cohesive batches, update references in the same batch, and run link checks after each batch.
- Risk: `Rejected` and `Retired` become interchangeable. Mitigation: require proof of prior authority for `Retired`; use `Rejected` only for proposals that never became current guidance.
- Risk: the validator grows into a documentation framework. Mitigation: parse only the fixed plain-Markdown metadata and required headings with Node standard-library code.
- Risk: unrelated dirty NanoCore work is included accidentally. Mitigation: edit, verify, stage, and commit only the explicit documentation and later validator paths owned by this plan.

## Checkpoints

### 2026-07-11: Phase 3 Archive Classification Complete

- Confirmed that eight pre-existing `superseded/` documents have continuing contracts under named active specs or stable core guidance; added exact terminal metadata and document-specific lifecycle and retention evidence without changing their placement.
- Reclassified two ended release/triage records and all 11 removed pre-rebuild Web UI slices as `Retired`, moved them under `retired/`, and used `Current Guidance: None` because later clean-slate work does not continue those contracts.
- Found no evidence-backed proposal that was declined before acceptance, so no speculative `rejected/` directory was created.
- Repaired links affected by the moves, validated all 115 date-prefixed spec files, and reduced the temporary legacy inventory from 21 entries to zero.

### 2026-07-11: Phases 4 And 5 Verified

- Updated the active-spec index to cover all 60 root specs, removed completed migration notices, repaired every stale old-directory reference, and retired the temporary legacy inventory file.
- Final classification is 60 active specs, 42 `Superseded` specs, 13 `Retired` specs, and no evidence-backed `Rejected` specs; active authority is 56 `Accepted` and 4 `Draft`.
- Final implementation alignment for active specs is 49 `Implemented`, 6 `Partial`, and 5 `Not Started`; every terminal spec uses `Implementation: N/A`.
- The focused validator tests, lifecycle validator without exceptions, scoped Biome check, model-catalog validation, active-index coverage, spec-link audit, documentation-link audit, old-path search, invalid-value search, and whitespace checks pass.
- `CI=true pnpm run check:repo` reaches and passes the lifecycle validator, then remains blocked by unrelated uncommitted NanoCore work: formatting errors in `workspace-filesystem-staging.ts` and `workspace-review-git.test.ts`, plus an unused `rootIdentity` warning in `filesystem-workspace-sync.test.ts`. This plan does not modify those files.

### 2026-07-11: Phase 3 Superseded Consolidation Batch 2 Complete

- Reclassified and moved the remaining 13 replacement-backed documents from `retired/` to `superseded/`: Agent Workflow, App API slices, Human Attention bridges, NanoCore kernel slices, and Test Strategy slices.
- Added exact terminal metadata plus document-specific lifecycle and retention reasons tied to the active workflow, protocol, storage, client, human-attention, and testing authorities.
- Updated every repository reference to the moved paths and verified all relative Markdown links in the batch.
- Reduced the temporary legacy inventory from 34 to the 21 documents that were already under the old `superseded/` taxonomy; the `retired/` tree now contains only its directory guide pending true-retirement moves.

### 2026-07-11: Phase 3 Superseded Consolidation Batch 1 Complete

- Reclassified and moved 21 clear consolidation documents from `retired/` to `superseded/`: Agent Setup and Runtime Supply, NanoCore Config and Identity, Protocol Hardening, and Worker Runtime communication/materialization.
- Used the accepted consolidation specs as current guidance and their dated contract boundaries as transition evidence; each archived document now records `Implementation: N/A`, transition metadata, a contract-specific lifecycle reason, and a distinct historical retention reason.
- Updated active consolidation specs and the historical triage record to the new paths in the same movement slice.
- Reduced the temporary legacy inventory from 55 to 34 without creating a rejected-spec directory.

### 2026-07-11: Phase 2 Active Spec Audit Complete

- Audited all 60 root specs for canonical fields, active authority, blocking questions, implementation projections, and explicit current-scope gaps; all 56 accepted specs remain current guidance and none contains a blocking open question.
- Normalized `docs/specs/20260629-openkit_policy_model.md` to `Implementation: Implemented` because the accepted contract intentionally owns a strict NGAC subset and the package projection satisfies that scoped contract; broader NanoCore enforcement remains owned by the separate enforcement-mapping spec.
- Normalized the self-improvement draft to exact `Implementation: Not Started` casing.
- Corrected Human Attention, Durable Scheduler, and Audit/Usage/Evidence from `Implemented` to `Partial` because their current projections identify non-deferred contract gaps: the improvement-proposal row and attention gaps, live scheduler reuse/parallel-safe dispatch, and remaining producer/scope-homing evidence coverage.
- Reduced the temporary legacy inventory from 57 to the 55 archived specs; the active root now validates with no exception.
- Final active distribution is 56 `Accepted` and 4 `Draft`; implementation alignment is 49 `Implemented`, 6 `Partial`, and 5 `Not Started`.

### 2026-07-11: Phase 1 Lifecycle Validator Implemented

- Added test-first coverage for every canonical active and terminal status, exact value casing, directory/status consistency, transition metadata, reason quality, evidence paths, and the temporary legacy inventory boundary.
- Added a dependency-free Node validator scoped to date-prefixed spec files and wired it into `check:repo` before Biome so lifecycle drift remains visible even when unrelated source checks fail later.
- Recorded the 57 known legacy paths explicitly: all 55 archived specs plus the two active specs with non-canonical `Implementation` values.
- Kept the temporary inventory path-scoped so new or uninventoried lifecycle defects fail immediately; every later migration batch must remove its corrected paths, and final verification must delete the inventory.

### 2026-07-11: Plan Started And Canonical Rules Established

- Re-read the repository, spec, and change-record guidance before editing.
- Reproduced the active/archive inventory and confirmed the two known invalid implementation values.
- Confirmed that the current directory definitions invert the agreed `Superseded` and `Retired` lifecycle meanings.
- Established the canonical statuses, transitions, evidence fields, reason requirements, and clean directory semantics.
- Aligned the `retired/` directory guide and added the missing `superseded/` directory guide without creating a speculative `rejected/` directory.
- Added an explicit migration notice so agents do not mistake the still-unmigrated archive layout for compliant final classification.
- Added the evidence-backed `Draft -> Superseded` path for proposals absorbed before acceptance and the explicit `Deprecated -> Accepted` reversal path.
- Aligned the core-document entry guide and local execution rule so they reject every archived terminal status as an active decision log.
- Scoped lifecycle validation to date-prefixed spec files so directory guides and local agent rules cannot be misclassified as specs.
- Verified all scoped Markdown links and whitespace, reproduced the 60 active and 55 archived spec baseline, and passed the `@openkit/models-dev-catalog` validation.
- The full `CI=true pnpm run check:repo` remains blocked by an unrelated dirty `apps/nanocore/src/runtime/workspace-review-application.test.ts` import-order error; this documentation change does not modify that file.
- Recorded the evidence-driven migration and validation phases before changing any archived spec classification.

## Implementation Summary

Completed. `docs/specs/README.md` now separates document authority from implementation alignment, defines evidence-backed `Superseded`, `Retired`, and `Rejected` semantics, and makes directory placement enforceable. A dependency-free validator and focused tests enforce exact values, status/location consistency, terminal metadata, reason quality, evidence paths, and replacement links through `check:repo`.

All 60 active and 55 archived specs were audited. Thirty-four replacement-backed documents moved from the formerly inverted `retired/` tree to `superseded/`; eight existing Superseded documents received complete evidence; two ended release/triage records and 11 deliberately removed pre-rebuild Web UI slices moved to `retired/`. No rejected proposal had sufficient evidence to justify a directory. All affected links, indexes, and directory guides now match the final tree, and the temporary migration exception file has been removed.

Implementation commits: `5822ff2`, `1268d20`, `d6e7cca`, `9e7f713`, `f684403`, `e083fc5`, `0f07484`, and `bbe8790`.

## Final Verification

- `node --test tests/spec-lifecycle.test.mjs`: passed, 3 tests.
- `node scripts/validate-spec-lifecycle.mjs`: passed with 0 temporary legacy entries.
- Exact inventory: passed, 60 active + 42 Superseded + 13 Retired = 115 specs.
- Active index: passed, 60/60 root specs listed.
- Spec-relative Markdown links: passed for all 115 specs.
- Documentation-relative Markdown links: passed for 168 documents after excluding `docs/okf-spec-v0.1-snapshot.md`, whose unresolved relative URLs are literal syntax examples.
- Old lifecycle paths and invalid legacy values: no matches.
- `pnpm exec biome check scripts/validate-spec-lifecycle.mjs tests/spec-lifecycle.test.mjs package.json`: passed.
- `pnpm --filter @openkit/models-dev-catalog test`: passed.
- `git diff --check` for all lifecycle-governance paths: passed.
- `CI=true pnpm run check:repo`: lifecycle validation passed; the later whole-worktree Biome phase is blocked only by the unrelated dirty NanoCore files recorded in the final checkpoint.
