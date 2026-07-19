# Documentation Model

Status: Accepted

This document owns the OpenKit documentation type system: the closed set of document types, each type's scope, authority, lifecycle, naming, and location, the precedence rules between types, the reading protocol agents follow to load context, and the generated documentation index contract.

This document does not own the content rules inside any single type: change-record execution rules stay in `docs/change-tracking.md`, specification lifecycle values stay with `scripts/validate-spec-lifecycle.mjs` and the specs it validates, story artifacts stay with `docs/specs/20260529-l6_story_acceptance.md`, and product doctrine stays in `docs/core/foundation.md`.

## Purpose

Documentation is the single source of truth for intent in this repository, and agents are its primary readers. A type system with closed membership, explicit authority, and a generated index lets an agent load exactly the context a task needs: no omission, because owning chains are complete; no waste, because discovery is one index lookup instead of corpus excavation. Rationale for this regime lives in `docs/engineering-doctrine.md`.

## Document Types

The following types are the complete set. A file under `docs/` that does not fit one of them is a validation error.

### Intent Documents

`docs/product-vision.md`, `docs/engineering-doctrine.md`, and `docs/roadmap.md`. They own purpose, premises, and direction. They govern what the system and the engineering process are for; they do not define behavioral contracts, and no implementation choice may cite them as its sole authority.

### Governance Documents

`docs/documentation-model.md` (this document) and `docs/change-tracking.md`. This document owns the type system; change-tracking owns the change-record execution rules that every agent applies during work. Amending the type system means amending this document first; no other document may add, remove, or redefine a documentation type.

### Core Model Documents

`docs/core/*.md`. Stable normative model and cross-aspect doctrine. Highest behavioral authority; short, normative, and slow-moving. Owned concepts follow the five decision classes and the two-independent-implementers bar defined in the root `AGENTS.md`.

### Specifications

`docs/specs/YYYYMMDD-short_name.md`. Precise, narrow design decisions with a validated lifecycle: `Draft`, `Accepted`, or `Deprecated` in the root; `Superseded`, `Retired`, and `Rejected` in their matching subdirectories. A `Draft` specification is the proposal form of this repository; design exploration that has not converged to one candidate stays in uncommitted working space. `scripts/validate-spec-lifecycle.mjs` enforces header and lifecycle rules.

### Change Records

`docs/changes/[datetime]-short_name.md` with types `change-plan`, `pr-summary`, `standalone-change`, and `release-summary`. They own delegation and execution context: plans before significant work, curated checkpoints during it, implementation summaries after it. Execution history never becomes design authority. Content rules live in `docs/change-tracking.md`.

### Audit Records

`docs/audits/YYYYMMDD-short_name.md`. Dated observation records produced by a rule in an owning specification: calibration reports, drift findings, load-bearing maps, detection-rate trends. They carry no authority of any kind; they are instrument readings that inform decisions recorded elsewhere. Each audit record links the specification whose rule produced it. Past records are never edited; a new observation is a new record.

### Operator And Reference Guides

Enumerated root documents: `docs/deployment.md`, `docs/nanocore-data-root-config.en.md`, `docs/nanocore-deployment-modes.en.md`, `docs/app-api.md`, and `docs/template-overview.md`. They are human- and operator-facing projections of core and specification contracts; divergence from their owning contracts is a defect in the guide, not a new contract. A matching `.zh.md` file is a translation projection of its canonical English document.

### External Snapshots

Verbatim pinned captures of upstream material, currently `docs/okf-spec-v0.1-snapshot.md`. They record provenance and capture date and carry no OpenKit authority.

### Cookbooks

`docs/cookbooks/*.md`. Reusable setup and operational recipes. Procedural, not normative; they follow accepted specs and tooling.

### Local Guides

`README.md` and optional `AGENTS.md` in each important directory, repository-wide. The README is the directory-level source of truth for local purpose, boundaries, and workflow; `AGENTS.md` holds only local agent execution rules. They are authoritative for directory-local workflow and nothing else. Local guides are discovered locally and are not listed in the documentation index.

### Generated Projections

`docs/INDEX.md`, produced by `scripts/generate-doc-index.mjs`. Generated projections are never edited by hand and never authoritative; the repository check regenerates and diffs them so drift fails loudly.

## Authority And Precedence

Authority is inversely proportional to change rate. When documents conflict, precedence is: core model documents, then accepted specifications, then guides and other projections. On one owned surface, a later accepted specification supersedes the document it names. Change records and audit records never outrank any of the above regardless of recency.

Intent documents do not compete in this ordering: they govern direction and premises, and a behavioral question must resolve to a core document or specification.

A conflict between documents is a defect, not a judgment call: the discovering agent records it as a drift finding in `docs/audits/` or a change record and the resolution updates the lower-authority document or escalates the design question. Agents do not silently pick a side.

## Reading Protocol

At task start an agent loads, in order: the root `AGENTS.md`, `docs/change-tracking.md` when the task will produce a change record, and `docs/INDEX.md` to locate the owning specification for the touched surface. It then loads that specification and the core documents its Core References section names, plus the local guides of directories it will modify. It stops there: wider loading happens only when an owning document explicitly requires another document, when the task itself is documentation governance, or when a conflict investigation demands it.

## Cross-Reference Rules

Specifications name their core dependencies in a Core References section and their peers in Related Docs. Change records link the owning core, product, and specification documents for their change. Audit records link the specification whose rule produced them and the documents or surfaces they observed. Guides link the contracts they project. Links use repository-relative paths so they are mechanically checkable.

## Index Contract

`docs/INDEX.md` lists every document of every type above except local guides, grouped by type, one line per document: path, lifecycle state where the type has one, and a one-line summary extracted from the document itself. The generator is `scripts/generate-doc-index.mjs`; `scripts/validate-doc-model.mjs` enforces closed-set membership and per-type record rules; the repository check runs both, and an index that does not match regeneration fails the check.

## Amendment Procedure

Adding, removing, or redefining a documentation type is a change to this document, made before any file of the new type is created, with a change record tracking the amendment and the validator updated in the same slice. The removal of `docs/working_logs/` predates this model and is recorded here: its durable functions were absorbed into change records, and residual references to it are defects.

## Related Docs

- `docs/engineering-doctrine.md`
- `docs/change-tracking.md`
- `docs/core/foundation.md`
- `docs/specs/20260529-l6_story_acceptance.md`
