---
status: Accepted
implementation: Implemented
---
# Documentation Field Contract

## Owns

- The three-layer separation for documentation metadata: YAML frontmatter as the syntax layer, an allowed value subset as the schema layer, and loud-failing strict validation as the parse layer.
- The requirement that one module owns the field vocabulary and per-type field rules, exports parsing and validation, and is the single reader of documentation metadata in this repository.
- The consolidation of `scripts/validate-doc-model.mjs`, `scripts/validate-spec-lifecycle.mjs`, and the header-reading half of `scripts/generate-doc-index.mjs` onto that module.
- The migration shape from the current plain `Field: value` header lines to frontmatter, including the round-trip equivalence predicate that makes a corpus-wide mechanical rewrite verifiable.
- The condition under which a machine-readable field declaration for non-Node consumers may be generated, and the prohibition on hand-maintaining one.

## Does Not Own

- Which fields each documentation type requires, and the canonical value set of each field. `docs/documentation-model.md` owns the field contract itself; this specification owns how that contract is expressed, parsed, and enforced.
- The documentation type set, authority precedence, reading protocol, and index contract, all owned by `docs/documentation-model.md`.
- Change-record content rules and program execution rules, owned by `docs/change-execution.md`.
- Any new field. `Applies-When` and `Owns-Surfaces` are named below only as shape constraints on the vocabulary; neither is authorized by this specification.

## Core References

- `docs/core/foundation.md`

## Problem

Documentation metadata is read by three scripts that disagree about where a header is.

- `scripts/validate-spec-lifecycle.mjs` scopes fields to the text before the first level-two heading, via `content.split(/\n##\s+/u, 1)[0]`.
- `scripts/validate-doc-model.mjs` scans the entire document with a global multiline pattern and requires exactly one match for `Type` and `Status`.
- `scripts/generate-doc-index.mjs` carries its own `METADATA_LINE_PATTERN` skip-list to find the first content line.

The consequence is observable, not theoretical: a change record whose body contains a line beginning `Status: ` at column zero fails `validate-doc-model.mjs` as a duplicate field while `validate-spec-lifecycle.mjs` never sees it. The same document is valid to one checker and invalid to another. The existing duplicate-status regression test compensates for the fragile scan rather than removing it.

The field vocabulary is small enough to state exactly. Across the committed corpus: `Status` (183), `Implementation` (127), `Type` (28), `Date` (16), `Started`, `Completed`, and `Branch` (3 each), `Updated` (1), plus `Status Changed`, `Current Guidance`, and `Decision Evidence` on terminal specifications. Usage has already drifted: `Date` appears in three types with no per-type rule, and `Updated` appears once.

## Three Layers

Metadata problems get attributed to the wrong layer, so the layers are named separately and each has one owner.

**Syntax layer.** A metadata block is YAML between `---` delimiters at the top of the file. This is the standard frontmatter convention and it is not modified, subsetted, or re-implemented. Parsing uses the `yaml` package, whose default is the YAML 1.2 core schema.

A hand-written parser is prohibited. The risk it carries is the one this repository spends the most effort eliminating: a document that means one thing to our reader and another to every standard tool. A divergence between our parse and the standard parse would be undetectable from inside the repository.

**Schema layer.** The allowed subset is flat scalars and arrays of strings: no nested mappings, no arrays of mappings, no anchors, no aliases, no multi-document streams. The subset is a constraint on what documents may contain, enforced by `zod` schemas, and `docs/documentation-model.md` owns it. The subset does not restrict the syntax layer; a document containing legal YAML outside the subset is a validation error, not a parse error.

Arrays of strings are inside the subset from the start because the vocabulary must be able to hold a multi-valued field without a second format change. This is a shape allowance, not authorization for any specific field.

**Parse layer.** YAML 1.2 core still performs implicit scalar typing. Verified behavior of `yaml` and `js-yaml` v4 at the 1.2 core schema: `2026-05-31` stays a string, `no` stays a string, `1.10` becomes the number `1.1`, and `0123` becomes the number `123`. The legacy YAML 1.1 timestamp and Norway coercions do not fire; numeric coercion does.

The mitigation is loud failure, not format restriction. Every field schema is `z.string()` or `z.array(z.string())`, so an implicitly typed number fails validation with the file, field, and received type named, rather than silently storing `1.10` as `1.1`. This follows the rule in `docs/engineering-doctrine.md` that a check throwing on the unknown is worth more than a tolerant one that silently passes what it does not understand. A field that must hold a numeric-looking value is quoted by its author; the failure message says so.

## Module Contract

One module, `scripts/lib/doc-fields.mjs`, owns the executable projection of the field contract.

It exports:

- `parseFrontmatter(content)` — returns the metadata mapping and the body offset, or a typed parse failure. It never guesses: a document with no frontmatter block returns an explicit absent result rather than an empty mapping.
- `validateFields(type, fields)` — returns errors for unknown fields, missing required fields, values outside a canonical set, values of the wrong shape, and values implicitly coerced away from string.
- `fieldSchemas` — the per-type `zod` schemas, so a consumer can compose rather than re-derive.

It owns the vocabulary and per-type required and optional sets as data, mirroring `docs/documentation-model.md`. It owns nothing else: no plugin mechanism, no per-field custom validator beyond canonical-set and shape checks, no document classification, no index formatting. Classification stays with the type system projection; formatting stays with the index generator.

The three current scripts become one validator plus one generator, both importing this module and neither containing a metadata regular expression. Removal of the last header regular expression from those scripts is an acceptance predicate, not a stylistic preference: a surviving regular expression means a fourth definition of where a header is.

## Generated Declaration

A machine-readable field declaration for consumers outside Node may be generated from `fieldSchemas` when a real consumer exists, following the generated-projection pattern already used by `docs/INDEX.md`: never hand-edited, regenerated by a script, and diffed in a `--check` mode so drift fails loudly.

No such consumer exists today, so none is generated. Building one now would be the abstraction-for-predicted-variants error the root `AGENTS.md` prohibits, and a hand-maintained declaration is prohibited in any case because it would be a second source of truth for the vocabulary.

## Migration

The migration inventory classified 212 documents: 187 carried legacy metadata and 25 carried none before the rewrite. The rewrite is mechanical, so its correctness must be evidence rather than trust.

**Round-trip equivalence is the acceptance predicate.** Before the rewrite, every legacy metadata-bearing document's fields are extracted with the three current parsers. After the rewrite, the same documents are parsed with the new module. The migration is accepted only when the two field mappings are identical for every rewritten document, except that keys containing spaces are renamed to their enumerated kebab-case forms (`Status Changed` becomes `status-changed`) rather than by an inferred rule.

The 187-document equivalence claim covers format conversion only. Three semantic corrections are separately authorized and are not claimed as round-trip-equal to their earlier values: this specification's lifecycle changed from `Draft` / `Not Started` to `Accepted` / `In Progress`; the two metadata-absent manual pages gained their required `status: Accepted`; and `docs/roadmap.md` changed from the non-canonical `status: Living document` to `status: Accepted`. The field-contract lifecycle correction preceded the slice-2 snapshot, the manuals were outside the 187-document legacy set, and the roadmap correction followed the exact rewrite gate.

Migration proceeds in three slices so that no slice both changes format and changes rules:

1. **Module and contract.** Add `yaml`, write the module and its tests, state the field contract in `docs/documentation-model.md`, and repoint the scripts. Both formats are accepted: frontmatter when present, the legacy header block otherwise. No document changes.
2. **Corpus rewrite.** Convert every legacy metadata header, verified by round-trip equivalence. No rule changes. The two current manual pages that lack their required `status` field are corrected in this slice to satisfy the existing per-type contract, not in the module-and-contract slice.
3. **Legacy removal.** Delete legacy header support and its tests. Frontmatter is then required for every type with required metadata and whenever a document declares optional metadata. A type with neither required nor present metadata may remain frontmatter-free.

Slice 1 leaves the repository in a dual-format state deliberately. The alternative is a single change that alters the parser and every document at once, which would make a round-trip failure impossible to localize.

## Acceptance Predicates

- No metadata regular expression remains in any validator or generator; all metadata reads route through the module.
- One header definition exists, so no document can be valid to one check and invalid to another. The duplicate-status regression test is replaced by a frontmatter-level uniqueness guarantee, which YAML provides by rejecting duplicate keys.
- A field whose value implicitly coerces to a non-string fails validation, naming the file, field, and received type.
- A document with YAML outside the allowed subset fails validation with the offending construct named.
- After slice 3, a document without frontmatter fails validation when its type requires metadata, and any declared optional metadata must be in frontmatter; a type with neither required nor present metadata may remain frontmatter-free.
- Round-trip equivalence holds for all 187 rewritten legacy metadata mappings at slice 2, with the space-to-kebab renames enumerated and the authorized semantic corrections above reported separately.
- `docs/documentation-model.md` states the vocabulary and per-type requirements, and the module's data mirrors it. A field present in one and absent from the other is a defect in the module.

## Risks

The migration touches every legacy metadata-bearing document and corrects required metadata on two manual pages, so a defect may be corpus-wide rather than local. Round-trip equivalence plus the dual-format slice bound that risk; a failure localizes to one document and one field.

Centralizing the vocabulary in one module invites it to grow into a schema framework. The module contract above is exhaustive by construction: three exports, data-only rules, no extension mechanism. A request to add a per-field custom validator is a signal that the field belongs to a type-specific check elsewhere.

The `yaml` dependency is new. It is maintained, widely used, and replaces roughly a dozen hand-written regular expressions across three scripts. Its default schema behavior is verified above rather than assumed.

## Related Docs

- `docs/documentation-model.md`
- `docs/change-execution.md`
- `docs/engineering-doctrine.md`
- `docs/toolchain.md`
