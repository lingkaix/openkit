---
status: Accepted
date: "2026-09-23"
decider: Engineer
---
# Engineering Vocabulary, Leading Words, And A Writer Role

## Decision

The engineering-process context gets its own Ubiquitous Language glossary, separate from the product vocabulary that Core Concepts owns. It lists classic software-engineering terms with their sources and project usage, which also serve as trigger words; the few project-specific terms that remain, each marked with a definition, scope, and owner; one fixed phrase for each meaning of an overloaded word; the collisions between the two contexts, removed by renaming where possible; and an avoid list. Classic terms, called leading words, are named where the behavior happens, in each role's contract, instead of all being added to the always-loaded root contract. A situation index maps what an agent is doing to the rules that apply, and fast-tier agents read a bounded task contract instead of the full corpus. A writer role drafts documentation text in documentation-led changes and edits documentation diffs; it must never change a criterion, every rewrite is checked by another context against the diff, and the writer cannot accept its own rewrite. Writing rules live in a writing reference that the writer applies but does not own.

## Reason

The engineer judged terminology a very serious problem that harms readability and the accuracy of discussion and can cause misunderstanding. Measurement on 2026-09-23 found "epoch" meaning an intent revision in governance and a runtime generation 597 times across 33 specifications; "owner" meaning a deciding document, a path writer, an effect owner, or code ownership without definition; and discussion codes such as G1 and D1 used without explanation. The engineer also observed that agents already know the classic concepts but act on them reliably only when a document names them. Naming them where a role acts triggers the behavior without turning every word into a standing obligation, which the doctrine warns about for always-loaded text. Writing quality is a separate question from correctness, and the known failure of rewrites is silent loss of qualifiers, so the writer's hard constraint and independent check follow.

Source: change record 202609231611190001-engineering_governance_landing, proposal, section Engineer Rulings, R-008.

## Rejected Alternatives

- A single glossary for product and process. Rejected because the two are different bounded contexts and Core Concepts already governs the product one.
- Listing all leading words in root AGENTS.md. Rejected because it dilutes attention and turns each word into an obligation.
- Leaving editing to the reviewer. Rejected because review already answers correctness, completeness, ownership, and simplicity.
- A fast-tier writer. Rejected; clear writing that preserves meaning needs judgment.

## Revisit When

A glossary term is still misread after landing, the avoid list needs a mechanical check, or the leading words in a role contract show no effect in trials.

## Affected Owners

- docs/glossary.md
- docs/writing.md
- docs/roles/writer.md
- docs/documentation-model.md
- AGENTS.md
