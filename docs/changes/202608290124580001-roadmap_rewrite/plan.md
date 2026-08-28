---
type: change-plan
status: verified
date: 2026-08-29
completed: 2026-08-29
branch: main
---
# Complete Product Roadmap Rewrite

## Intent Epochs

### Intent Epoch 1 — 2026-08-29 — Engineer Request

- **Outcome:** Replace `docs/roadmap.md` with one ordered, tickable, comprehensive path from the current implementation to complete Product Vision coverage.
- **Non-negotiables:** Derive the list from current implementation fact plus Product Vision; include every unfinished capability that remains inside the intended product; use no deferred bucket; order work from top to bottom; make each checkbox suitable for one issue, one change plan, one pull request, review, and merge; use independent Claude Code Agents through Herdr as consultants and use separate independent verifier and auditor agents after production.
- **Acceptance observations:** The final Roadmap is a checkbox list; contains only unfinished outcomes; removes completed, obsolete, duplicate, and implementation-detail entries; preserves accepted authority boundaries; makes the lowest-user-configuration-burden and all-in-one Workspace-not-vertical-replacement principles visible; and has a dependency-coherent order whose completion covers the intended system.
- **Exclusions:** No product implementation, public issue creation, pull request, commit, push, deployment, external publication, or invention of a second authority, workflow, universal resource, connector, or workbench framework.
- **Effect boundary:** Repository documentation only. Preserve unrelated working-tree changes, especially the existing Product Vision edit and the untracked staging-server deployment bundle.

### Intent Epoch 2 — 2026-08-29 — Outcome-Oriented Scope Clarification

- **Outcome:** Keep architecture, implementation status, dependency order, and technical feasibility as planning inputs, but express every Roadmap item as one concrete user-, operator-, or developer-perceivable capability or module rather than as a specification or implementation microtask.
- **Required capability chains:** Complete Operational Telemetry; source-linked Knowledge candidates from user-Agent work and interaction; evaluation, improvement proposal, governed application, rollback, and re-evaluation for Knowledge, Skill versions, scheduling strategy, and Sandbox configuration strategy; complete server-secret and Workspace-resource permission management over the existing Policy Kernel; and the BWM path from an external versioned BWM Skill through Meta-Skill authoring, Worker use, performance evaluation, improvement, and re-evaluation.
- **Boundary clarification:** Telemetry remains diagnostic while canonical product evidence owns evaluation truth; BWM and Meta-Skill remain independent Skill-package capabilities and do not introduce BWM-specific Core types; the Roadmap does not prescribe which Core, specification, code, or documentation owners each issue must change.
- **Acceptance observations:** Every checkbox describes a visible outcome, the list remains finite and ordered, the four required capability chains are explicit, and implementation-document choices are left to each issue's governed change plan.

### Intent Epoch 3 — 2026-08-29 — Commit And Concurrent-Ownership Instruction

- **Outcome:** Commit the completed Product Vision, Roadmap, generated documentation index, and this Roadmap change record after the concurrent release-management change lands separately.
- **Non-negotiables:** Regenerate `docs/INDEX.md` after the release-management specification becomes `Implemented`; use `git commit --only` with the four explicitly owned documentation paths; do not stage, modify, or commit release-management or staging-deployment paths.
- **Acceptance observations:** The generated index projects current Product Vision and Roadmap summaries plus the `Implemented` release-management lifecycle, the owned documentation diff passes its gates, and the path-scoped commit preserves all unrelated state.
- **Effect boundary:** Local repository documentation and one authorized local commit only; no push, pull request, release, deployment, publication, credential use, or mutation of concurrent work.

## Authority

- [`AGENTS.md`](../../../AGENTS.md)
- [`docs/change-execution.md`](../../change-execution.md)
- [`docs/documentation-model.md`](../../documentation-model.md)
- [`docs/product-vision.md`](../../product-vision.md)
- [`docs/core/foundation.md`](../../core/foundation.md)
- [`docs/core/work-model.md`](../../core/work-model.md)
- [`docs/core/communication.md`](../../core/communication.md)
- [`docs/specs/README.md`](../../specs/README.md)

## Current Facts

- The former deferred-design register has been replaced by nine ordered phases and 105 sequential unchecked outcome issues.
- Product Vision retains its prior implementation posture and adds the lowest-user-configuration-burden and all-in-one Workspace-not-all-in-one-IT principles.
- The release-management change landed separately as `59b86c14`; its specification is `Implemented`, and the regenerated `docs/INDEX.md` projects that current lifecycle without absorbing any release-management path into this change.
- The staging-server deployment bundle remains concurrent and outside this plan's write and commit ownership.
- NanoHost implementation evidence remains internally inconsistent: the accepted specification projects the A1 noninterference gate as proved, while open `NHC-FND-054` and the active staging checkpoint state that the exact retained real-host gate has not passed. The Roadmap follows current implementation evidence and retains the outcome as R001.

## Material Unknowns

- No material Roadmap classification or ordering unknown remains after implementation inventory, current-state reconciliation, independent review, and final verification and audit.
- The NanoHost specification projection drift remains an external owner finding; it does not make the Roadmap outcome or this documentation commit ambiguous.

## Method And Evidence

- Reconcile Product Vision, Core, active specifications, active change records, Git, representative code, and tests before classifying an outcome as complete or incomplete.
- Use independent Herdr-hosted Claude Code consultants for product-scope, implementation-status, and sequencing views; treat their reports as evidence, never acceptance.
- Produce the Roadmap in one canonical file, then run focused documentation and repository checks.
- After production, use separate Herdr-hosted Claude Code verifier and auditor agents; correct in-scope findings locally and retain unresolved scope or authority questions explicitly.

## Working Checkpoint

- **Status:** Closed and verified.
- **Current belief:** The Roadmap contains the finite unfinished path to Product Vision completion while preserving external-system authority, BWM-as-Skill placement, Telemetry-versus-evidence separation, and the existing Core ownership model.
- **Frontier:** Independent local review, fresh-context direction check, final Claude Code verification, and final Claude Code audit all accept the corrected actual bytes.
- **Next Action:** Commit only the four explicitly owned documentation paths; Git history containing this record is the commit evidence.

## Closeout Summary

- Rewrote `docs/roadmap.md` as nine dependency-ordered phases with 105 sequential unchecked outcome issues, each intended to fit one issue, change plan, pull request, independent review, and merge.
- Added explicit complete paths for Operational Telemetry, source-linked Knowledge candidate extraction, governed evaluation and re-evaluation of Knowledge, Skill and BWM versions, scheduling strategies, and Sandbox configuration strategies, complete server-secret and Workspace-resource permissions, agent-managed low-configuration operation, and BWM Meta-Skill creation and Worker use.
- Added the missing NanoHost distribution, server installation and version rollback, and full tagged-release outcomes exposed by the concurrent release-management owner.
- Updated `docs/product-vision.md` to retain its implementation posture and add the requested product-design principles without modifying any documentation-language owner.
- Regenerated `docs/INDEX.md` after release-management commit `59b86c14`, projecting the Product Vision, new Roadmap, and `Implemented` release-management specification from current bytes.
- Preserved the untracked staging-server deployment bundle and made no change to release-management, NanoHost, or other concurrent owner paths.
- Retained NanoHost noninterference as R001 because open `NHC-FND-054` and the active staging checkpoint state that the required real-host proof is missing; the contradictory NanoHost specification projection remains for its owner to reconcile.

## Verification Evidence

- Three independent Herdr-hosted Claude Code consultants completed product-scope, implementation-status, and dependency-sequencing reviews before production.
- Independent Codex scope, implementation-gap, and sequence verifiers inspected the repository, and the independent final Roadmap reviewer returned `PASS` after all findings were corrected; its fresh-context direction check returned `Continue` before durable commitment.
- The final Herdr-hosted Claude Code verifier and auditor each inspected the corrected actual Roadmap and returned `PASS` after their omissions, dependency, sizing, and current-fact findings were corrected.
- The structural check reports 105 tasks, IDs R001 through R105, 105 unique IDs, sequential order, nine phases, and zero checked items.
- `node scripts/generate-doc-index.mjs --check`, `node scripts/validate-doc-model.mjs`, and `node scripts/validate-spec-lifecycle.mjs` pass; the documentation model covers 204 documents.
- `node --test tests/doc-model.test.mjs` passes 67 of 67 tests with zero failures, skips, cancellations, or todos.
- `git diff --check` passes for the four owned documentation paths.
- No tag, push, pull request, release, deployment, publication, credential use, or other external effect occurred.
