---
status: Accepted
---
# Documentation Model

This document owns the OpenKit documentation type system: the closed set of document types, each type's scope, authority, lifecycle, naming, and location, the precedence rules between types, the reading protocol agents follow to load context, and the generated documentation index contract.

This document also owns the metadata field contract: which fields exist, which each type requires, and each field's canonical values. The validation modules are its executable projection and hold no authority of their own; a field present in a module but not stated here is a defect in the module.

This document does not own the content rules inside the body of any single type: material change execution and change-record content rules stay in `docs/change-execution.md`, story artifacts stay with `docs/specs/20260529-l6_story_acceptance.md`, and product doctrine stays in `docs/core/foundation.md`. It does not own how the field contract is expressed, parsed, or enforced, which is `docs/specs/20260729-documentation_field_contract.md`.

## Purpose

Engineers own current user intent. Documentation is the durable record of recorded intent and accepted decisions in this repository, and agents are its primary readers. A type system with closed membership, explicit authority, and a generated index lets an agent load exactly the context a task needs: no omission, because owning chains are complete; no waste, because discovery is one index lookup instead of corpus excavation. Rationale for this regime lives in `docs/engineering-doctrine.md`.

## Document Types

The following types are the complete set at any moment, and a file under `docs/` that does not fit one of them is a validation error. Complete is not the same as final: the set is closed against silent additions, not against growth. How it grows is defined under Type Induction.

### Intent Documents

`docs/product-vision.md`, `docs/engineering-doctrine.md`, `docs/change-execution-rationale.md`, and `docs/roadmap.md`. They own purpose, premises, and direction. They govern what the system and the engineering process are for; they do not define behavioral contracts, and no implementation choice may cite them as its sole authority.

`docs/change-execution-rationale.md` preserves observations, recorded costs, and rejected alternatives behind `docs/change-execution.md`. Rules remain in the owner and reasons remain in the intent document; obsolete rationale is pruned when it no longer explains a current direction.

### Governance Documents

`docs/documentation-model.md` (this document), `docs/change-execution.md`, and `docs/verification-instruments.md`. This document owns types and precedence, change execution owns adaptive coordination and change-record content, and verification instruments owns whether a deciding observation can be believed. Amending the type system means amending this document first.

The third member was extracted after oracle and effect-domain rules had been scattered among workflow and testing documents; a fourth member is the event that promotes it to a `docs/governance/` directory rather than another filename exception. This type system governs Markdown documents; opaque legacy machine-readable evidence is not a documentation type.

### Core Model Documents

`docs/core/*.md`. Stable normative model and cross-aspect doctrine. Highest behavioral authority; short, normative, and slow-moving. Owned concepts follow the five decision classes defined in the root `AGENTS.md`.

An active Core document uses `status: Accepted`. When an accepted retirement decision requires retaining the old Core document as evidence, an auditor moves its final form under `docs/core/retired/` with `status: Retired` and the lifecycle fields and reasons defined below. No archived Core document exists today, so the first such retirement also adds the smallest executable type projection required for that directory; neither the directory nor its validator branch is created speculatively.

### Specifications

`docs/specs/YYYYMMDD-short_name.md`. Precise, narrow design decisions with a validated lifecycle, whose values and per-type field requirements are stated under Field Contract below. A `Draft` specification is the proposal form of this repository; design exploration that has not converged to one candidate stays in uncommitted working space. `scripts/validate-spec-lifecycle.mjs` enforces header and lifecycle rules.

### Change Records

`docs/changes/[datetime]-short_name.md`, or for a new change-plan `docs/changes/[datetime]-short_name/`, with types `change-plan`, `pr-summary`, `standalone-change`, and `release-summary`. They own delegation and execution context: plans before significant work, curated checkpoints during it, implementation summaries after it. Execution history never becomes design or governance authority, and a durable rule is incomplete while any authoritative document depends on a specific change record to supply it. Content rules live in `docs/change-execution.md`.

A change record takes one of two forms. A change-plan is a directory `docs/changes/[datetime]-short_name/` containing required `plan.md`, optional `findings.md`, optional `route-log.md`, and, only for programs that used the retired controller, optional legacy `state.json`. The directory carries the identity. Raw transcripts, checkpoints, and intermediate evidence stay uncommitted under `temp/`; other record types remain flat files.

Optional members are evidence, not authority. A legacy state file is retained unchanged and interpreted only under the historical framework that produced it; no active owner requires or appends to it. A findings report records observations, their current dispositions, and one follow-up index under the body contract in `docs/change-execution.md`; each finding remains non-authorizing until user intent or an accepted owner admits the work. A route log records the plan's route history under `docs/change-execution.md`; it has no induced type of its own and classifies under the findings type until a second such member justifies a split. No optional member is an audit record.

### Audit Records

`docs/audits/YYYYMMDD-short_name.md`. Dated observation records produced by an owning rule: calibration reports, drift findings, load-bearing maps, detection-rate trends, Core retirement records, and specification terminal-archive records. They carry no authority of any kind; they are evidence that informs decisions recorded elsewhere. Each audit record links the specification or governance document whose rule produced it. Past records are never edited; a new observation is a new record.

### Terminal Archive Audit And Archive Immutability

Only an auditor may execute the final transition of a specification into its `Superseded`, `Retired`, or `Rejected` archive, or of a Core document into its `Retired` archive. The auditor does not decide the transition: an engineer-approved decision or accepted surviving authority must already state the disposition, and the auditor returns the operation when ownership, receiver, lifecycle, or retention evidence is incomplete.

The terminal-archive change produces one dated non-authorizing audit record and performs the final metadata update and archive move together. The record names every exact source and final archive path, the accepted transition decision, the disposition of every authority-bearing criterion, every inbound current-guidance link disposition, each final archived-file SHA-256, and the evidence supporting the lifecycle and retention reasons. Each criterion is preserved, moved to named current authority, or ended by the accepted decision; each inbound current-guidance link is repointed to current authority, retained only as an explicitly historical link, or removed. One audit may cover multiple documents only when one transition decision and one criterion inventory govern all of them.

A retired Core document requires `status: Retired`, `status-changed`, `current-guidance`, and `decision-evidence`, and may carry `date` and `updated`; the first such retirement adds that row to the per-type table below together with its schema. It uses `current-guidance: None`, because its authority ended rather than continuing under a replacement. Its `decision-evidence` names the repository-relative path of the same-change terminal-archive audit. It contains a substantive `Lifecycle Reason` that explains the accepted decision or condition that ended its authority and how its authority-bearing criteria were disposed, plus a distinct substantive `Retention Reason` that identifies the historical constraints, alternatives, migration detail, or audit evidence worth preserving. Renewed authority is a new active Core document with `status: Accepted` and a different repository-relative path; it does not reactivate or replace the archived identity in place.

The first transition that needs an archive path or governance-generated audit-record projection not already recognized adds the smallest executable projection in the same change. No speculative `docs/specs/rejected/` or `docs/core/retired/` directory or validator branch is added before its first real use.

The terminal-archive commit is the archived document's freeze boundary. After it lands, an archived Core document or terminal specification MUST NOT be edited, renamed, moved again, or deleted. A later observation is written as a new audit record; renewed authority is written in current guidance or in a new active Core document or specification with a new document identity. Neither correction path mutates the archive, and renewed work links the terminal-archive audit only when that audit exists.

This rule is prospective. Documents already under a terminal specification archive before adoption require no audit backfill or separate migration. The bytes committed by the rule-adoption change, including its authorized evidence corrections, become their freeze baseline.

### Platform References

Enumerated root documents: `docs/deployment.md`, `docs/app-api.md`, and `docs/toolchain.md`. Each takes one angle on the system — where Core and agents run, where an App API contract lives, which tools are default — and states the principles and shape of that angle while summarizing the contracts that already own its details. They live at the repository documentation root so that an agent or a human finds them without searching.

They own no behavioral contract. Stable design belongs to core documents, technical detail belongs to specifications, and executable fact belongs to code and configuration. Every platform reference has exactly one `## Owns` section and one `## Does Not Own` section, including when `## Owns` states that the guide owns no decision. A platform reference may own narrow repository-operation decisions that no Core document or specification owns, such as the default toolchain and the setup and dependency procedure that realizes it in `docs/toolchain.md`; each owned decision MUST be stated inside that document's `## Owns` section, and the exception does not authorize product behavior, architecture, or a broader guide authority. A repository-operation decision that root `AGENTS.md` routes to a platform reference is owned there and MUST NOT also be stated in root, so the route and the owner never disagree. A platform reference is otherwise a slice and projection across those owners, plus the judgments described below.

#### Why They Exist

Authority here is deliberately fragmented: each core document owns one aspect, each specification owns one narrow decision. That is what makes ownership unambiguous, and it is also what makes a cross-cutting question expensive to answer, because the answer is distributed across documents that must first be located. As the corpus and the code grow, the cost of locating grows with them.

A platform reference pays that cost once, so entering from one angle reaches the owning documents in one hop instead of searching. Deleting them to keep authority pure would trade a real cost — context an agent fails to load — for a purity gain, and missed context produces worse drift than a stale summary does.

Their defining risk is the mirror of their purpose: a hand-written summary of something owned elsewhere diverges from it over time. That has already happened here repeatedly. The rules below bound the risk rather than pretend it is absent.

#### No Authority Inversion

A specification, core document, or implementation must never take a contract fact from a platform reference. It resolves that fact at the owner: the core document, the specification, the schema, or the configuration file that holds it. A reference that becomes the cited source of a contract has inverted the authority order, and that inversion is a defect in both documents.

The mechanism of the inversion is ordinary and worth naming: a reference summarizes a sentence, a specification copies the summary, and later no reader can tell which copy is the source. Its correction is mechanical rather than discretionary — a platform reference path may not appear in a specification's `Core References` section, because that section names contract dependencies.

When a platform reference disagrees with a core document, a specification, or running code, the reference is stale. Fix the reference. It never wins, and a conflict is never evidence that the owner is wrong.

#### Judgments

Besides the narrow repository-operation decisions it marks under `## Owns`, the one thing a platform reference may hold is a judgment: a calibrated premise about scope, priority, or optimization target, formed from experience, team shape, and external conditions rather than derived from a contract. The current deployment baseline is one — that the product is optimized for a team typically under ten people is a design and verification profile, not a limit anything enforces.

Such a judgment is high-value and hard to pin in a core document or a specification, because core owns product-independent semantics and a specification owns a narrow falsifiable design decision. A judgment is neither. It is the same species as the delegation premise in `docs/engineering-doctrine.md`, applied at a narrower scope.

Judgments live in one `## Judgments` section placed before any projection, so a reader meets the authority boundary before the summaries. With `## Owns` they are the only citable content in the document, and they follow the rules Intent Documents already follow: they are not behavioral contracts, no implementation choice may cite one as its sole authority, and on any behavioral question a core document or specification decides. Citing a judgment as a premise is therefore not the inversion described above.

Two constraints keep the section from becoming a place where everything accumulates:

- A judgment is a premise about scope, priority, or optimization target. The moment it constrains system behavior with must or must not, it belongs to a core document or a specification instead.
- A judgment states what it rests on and what observation would overturn it. A judgment that cannot be falsified is a decree, and `docs/engineering-doctrine.md` already requires this of the delegation premise for the same reason.

#### Three Rules For The Rest

**Mark authority by section.** `## Judgments` holds the citable premises, `## Owns` holds any narrow repository-operation decisions the document owns, and `## Does Not Own` states its explicit exclusions; every other section is projection, so the authority of a sentence is never inferred from its tone. Every platform reference has exactly one `## Owns` and one `## Does Not Own`. Language asserting the document's own authority belongs only in `## Judgments` and `## Owns`. Writing that this document does not own something or that another document owns it is attribution, not assertion, and belongs anywhere.

**Generate a projection rather than write one.** A projection a script regenerates cannot rot; one maintained by discipline will. Where the projected facts are derivable — package exports, schema membership, configured tool versions, which document owns which surface — the projection belongs to Generated Projections below, with a `--check` mode that fails on drift as `docs/INDEX.md` already does. A section that could be generated and is not is a known debt, and naming it as such beats restating it confidently.

**Link the residue; never restate it.** Narrative that cannot be generated stays hand-written, and names and links its owner instead of reproducing what the owner says. A restated copy carries no authority, so it adds nothing while it agrees and misleads once it drifts. A platform reference is measured by how fast it gets a reader to the right owner, not by how much it explains without them.

#### Usage And Drift Detection

An agent loads a platform reference when its task enters from that angle, then follows the links to the owning documents the change actually touches.

Each reference names the owners it projects, so its staleness is answerable rather than invisible: whether any named owner changed since the reference was last updated is a question git can settle. Zero authority plus no mechanical check would let this material rot silently, which is the failure `docs/engineering-doctrine.md` warns about; naming owners is what makes the check possible.

These documents remain enumerated rather than directory-classified, which costs a validator edit per member. Treat that as a defect to retire as members cluster, not as a model to copy.

### User Manuals

`docs/manual/*.<lang>.md`. Operator- and end-user-facing documentation of the built product: how to deploy, configure, run, and verify it. They carry no authority.

Manuals are the one localized type, because their readers are not required to read English. Every page states its language in a mandatory `.en.md` or `.zh.md` suffix, a page without one is a validation error, and `.en.md` is canonical: a translation may not exist without the English page it projects. Adding a language means extending the suffix set in `scripts/validate-doc-model.mjs`, not inventing a per-language type. Every other documentation type remains English-only and unsuffixed under the root `AGENTS.md`.

The type is distinguished by audience: a manual addresses whoever runs a release artifact, while every other type addresses whoever changes the repository. Change records, audit records, and snapshots are also written after the fact, so lagging behind implementation is not unique to manuals. What is unique is the consequence: a change record that disagrees with current behavior is historical evidence and stays as written, while a manual that disagrees is a live defect and must be corrected. A manual therefore never wins a conflict — against an accepted specification it is presumed stale — and its drift check runs against running behavior rather than against a design document.

A translated page is a projection of its canonical English page, never an independent source. Where the two disagree, the English page wins and the translation is the defect. The two retired `.zh.md` tombstones under the `docs/` root, which announced that localization had stopped, are deleted: localization now lives in this type with a validated canonical sibling rather than as loose root files.

### External Snapshots

Verbatim pinned captures of upstream material, currently `docs/okf-spec-v0.1-snapshot.md` and `docs/okf-spec-v0.2-snapshot.md`. They record provenance and capture date and carry no OpenKit authority.

### Cookbooks

`docs/cookbooks/*.md`. Reusable setup and operational recipes. Procedural, not normative; they follow accepted specs and tooling.

### Local Guides

`README.md` and optional `AGENTS.md` in each important directory, repository-wide. The README is the directory-level source of truth for local purpose, boundaries, and workflow; `AGENTS.md` holds only local agent execution rules. They are authoritative for directory-local workflow and nothing else. Local guides are discovered locally and are not listed in the documentation index.

### Generated Projections

`docs/INDEX.md`, produced by `scripts/generate-doc-index.mjs`. Generated projections are never edited by hand and never authoritative; the repository check regenerates and diffs them so drift fails loudly. A machine-readable declaration of the field contract belongs to this type if one is ever needed, generated from the owning module rather than maintained by hand.

## Field Contract

Metadata is a YAML frontmatter block between `---` delimiters at the top of the file. Values are restricted to strings and arrays of strings: no nested mappings, anchors, aliases, or multi-document streams. Every value is a string even when it looks like a number or a date, so a numeric-looking value is quoted; an implicitly typed value is a validation error rather than a silent conversion. `docs/specs/20260729-documentation_field_contract.md` owns the syntax, parse, and enforcement design, and one module owns the executable rules.

The vocabulary is closed. A field not listed here is a validation error.

| Field | Shape | Canonical values |
| --- | --- | --- |
| `status` | string | Per type. Specifications: `Draft`, `Accepted`, `Deprecated` in the root; `Superseded`, `Retired`, `Rejected` in their matching subdirectories. Active Core documents: `Accepted`; archived Core documents under `docs/core/retired/`: `Retired`. Change records: `planned`, `in-progress`, `blocked`, `implemented`, `verified`, `superseded`. Governance, intent, platform references, and manuals: `Accepted`. |
| `implementation` | string | `Not Started`, `In Progress`, `Partial`, `Implemented`, `Diverged`, `N/A`. |
| `type` | string | `change-plan`, `pr-summary`, `standalone-change`, `release-summary`. |
| `date` | string | `YYYY-MM-DD`. |
| `updated` | string | `YYYY-MM-DD`. |
| `started` | string | `YYYY-MM-DD`. |
| `completed` | string | `YYYY-MM-DD`. |
| `branch` | string | Free text. |
| `status-changed` | string | `YYYY-MM-DD`. |
| `current-guidance` | string | Free text. |
| `decision-evidence` | string | Free text. |

Per-type requirements:

| Type | Required | Optional |
| --- | --- | --- |
| Specification, active | `status`, `implementation` | `date`, `updated` |
| Specification, Deprecated-or-terminal | `status`, `implementation`, `status-changed`, `current-guidance`, `decision-evidence` | `date`, `updated` |
| Change record | `type`, `status` | `date`, `started`, `completed`, `branch` |
| Core model, active; governance; intent; platform reference; manual | `status` | `date`, `updated` |
| Audit record, findings report, cookbook, external snapshot, local guide | none | `status`, `date` |
| Generated projection | none | none |

A field is optional only where its absence changes no decision. Adding a field, changing a canonical value set, or moving a field between required and optional is an amendment to this document, made before the module changes.

## Authority And Precedence

Authority is inversely proportional to change rate. When documents conflict, precedence is: core model documents, then accepted specifications, then platform references, manuals, cookbooks, and other projections. On one owned surface, a later accepted specification supersedes the document it names. Change records and audit records never outrank any of the above regardless of recency.

Intent documents do not compete in this ordering: they govern direction and premises, and a behavioral question must resolve to a core document or specification. The `## Judgments` section of a platform reference holds premises under the same terms, so citing one is not a claim of contract authority. Its `## Owns` section is different: a narrow repository-operation decision marked there is authoritative for that decision, outranked by no document because none other owns it, and it never reaches product behavior or architecture.

A conflict between documents is a defect, not a judgment call: the discovering agent records it as a drift finding in `docs/audits/` or a change record and the resolution updates the lower-authority document or escalates the design question. Agents do not silently pick a side.

## Reading Protocol

At task start an agent loads root `AGENTS.md`, then `docs/change-execution.md` for material coordination or a change record, and `docs/INDEX.md` to locate the owner. It loads `docs/verification-instruments.md` only when an instrument will decide acceptance or a harness must be admitted. It then reads the owning specification, its Core References, and local guides for modified directories. Wider loading occurs only when an owner, documentation-governance task, or conflict investigation requires it.

## Cross-Reference Rules

Documentation dependency direction is a hard rule. Authority flows one way; change records are removable evidence under Change Records And Retention in `docs/change-execution.md`, not stable link targets.

| From → To | Core | Specification | Change record |
| --- | --- | --- | --- |
| **Core** | allowed | **forbidden** | **forbidden** |
| **Specification** | allowed | allowed | **forbidden** |
| **Change record** | required | required | n/a |

Neither a Core document nor a specification may link to a change record in prose or metadata. Change records link the owning core, product, and specification documents for their change; authority never links back. Audit records link the specification or governance document whose rule produced them and the documents or surfaces they observed. Platform references and manuals link the contracts they project and do not restate rules another document owns: under Authority And Precedence a restated copy carries no authority, so it adds nothing while it agrees and misleads once it drifts. A platform reference path may not appear in a specification's `Core References` section, because that section names contract dependencies and a reference owns no behavioral contract; naming one in prose or Related Docs as a premise remains allowed. Specifications name their core dependencies in a Core References section and their peers in Related Docs. Links use repository-relative paths so they are mechanically checkable; every resolved link must name a file that exists.

## Index Contract

`docs/INDEX.md` lists the documents used to locate owners: every document of every type above except local guides, the index itself, and change records, grouped by type, one line per document: path, the lifecycle fields the type requires under Field Contract, and a one-line summary extracted from the document itself. Change records are not enumerated. The generated index states that they live under `docs/changes/` and are discovered by listing that directory. The generator is `scripts/generate-doc-index.mjs`; `scripts/validate-doc-model.mjs` enforces closed-set membership and per-type record rules; the repository check runs both, and an index that does not match regeneration fails the check.

## Type Induction

The type set cannot be enumerated in advance, and attempting it is the failure this section prevents. Types are induced from documents that already exist, never predicted for documents that might.

Two things are being decided whenever a document is added, and conflating them is what makes the model feel rigid:

**Authority level** — what wins in a conflict. This must be settled for every committed document, because Authority And Precedence has nothing to resolve otherwise. It is genuinely enumerable and stays small, because the meaningful answers to "who wins" do not multiply as documents do. Behavioral-contract authority is gated by location: a document owning a behavioral contract lives in `docs/core/` or `docs/specs/`. Governance and intent are fixed singletons named above. Everything else carries no behavioral-contract authority, whatever it is called; the narrow repository-operation decisions explicitly authorized under Platform References are not behavioral contracts. A document outside `docs/core/` or `docs/specs/` that appears to own a behavioral contract is either misplaced or restating an owner, and both are defects.

**Category** — a name for a cluster of similar documents. This is organization. It is induced from members that exist, not predicted for members that might.

Directories are therefore cheap and type names are expensive. Admitting a directory costs one definition here, one classification branch in `scripts/validate-doc-model.mjs`, one index group in `scripts/generate-doc-index.mjs`, and a change record — paid once, after which adding documents to it costs nothing. Naming a type additionally adds a precedence question and a lifecycle claim that every future reader carries.

The bar for naming one is the bar the root `AGENTS.md` sets for extracting a shared concept in code: the behavior is **already** repeated across members that exist, and one definition describes all of them. Member count is not the test. Two existing documents whose shared behavior one definition covers clear it; a single document does not, and neither does any number of predicted future members — that is the abstraction-for-predicted-variants error the root rules prohibit for code, and documentation is not exempt.

A type is also induced by splitting one whose definition has stopped describing its members. When a type accumulates documents that differ in audience or authority, the honest repair is to split it, not to widen the definition until it covers everything.

A document whose type is not yet induced lives under the closest existing type, and is reclassified when the split happens; it never gets a placeholder type, because the validator must be able to classify every committed file. Material with no settled authority level at all is not admitted: unconverged design stays in uncommitted working space, as under Specifications above, because a committed document whose authority is undefined cannot be resolved against anything.

A type defined by enumerating filenames is a type that has not finished being induced: it charges a validator edit per member, which is the cost directory classification exists to remove. Prefer a directory.

## Amendment Procedure

Adding, removing, or redefining a documentation type is a change to this document, with a change record tracking the amendment and the validator updated in the same slice. A new type is admitted with a directory and a classification branch rather than a filename list, so the amendment is paid once instead of once per member.

No file may be created under a type that does not yet exist. When a type is induced by splitting an over-broad one, its future members are already committed under the type being split, and the amendment and their reclassification land in the same slice; nothing sits unclassified in between.

The removed long-run archive type predates this model; its durable functions were absorbed into change records, and noisy run files now remain in uncommitted working space. The retired translation type is recorded the same way: repository documentation is English-only, and its two localized files were tombstones pointing at their English originals.

## Related Docs

- `docs/engineering-doctrine.md`
- `docs/change-execution.md`
- `docs/core/foundation.md`
- `docs/specs/20260529-l6_story_acceptance.md`
- `docs/specs/20260729-documentation_field_contract.md`
