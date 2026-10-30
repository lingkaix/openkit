---
status: Accepted
implementation: Implemented
kind: process
---
# Documentation Field Contract

## Owns

- The three-layer separation for documentation metadata: YAML frontmatter as the syntax layer, an allowed value subset as the schema layer, and loud-failing strict validation as the parse layer.
- The requirement that one module owns the field vocabulary and per-type field rules, exports parsing and validation, and is the single reader of documentation metadata in this repository.
- The consolidation of documentation validation, specification lifecycle validation and index metadata reading onto that module.
- The migration shape from the current plain `Field: value` header lines to frontmatter, including the round-trip equivalence predicate that makes a corpus-wide mechanical rewrite verifiable.
- The condition under which a machine-readable field declaration for non-Node consumers may be generated, and the prohibition on hand-maintaining one.

## Does Not Own

- Which fields each documentation type requires, and the canonical value set of each field. `docs/documentation-model.md` owns the field contract itself; this specification owns how that contract is expressed, parsed, and enforced.
- The documentation type set, authority precedence, reading protocol, and index contract, all owned by `docs/documentation-model.md`.
- Change-record content rules and program execution rules, owned by `docs/change-execution.md`.
- Any new field. `Applies-When` and `Owns-Surfaces` are named below only as shape constraints on the vocabulary; neither is authorized by this specification.

## Core References

- `docs/core/doctrine.md`

## Problem

Independent metadata readers can disagree about header boundaries and field types. One shared reader prevents a body example from being mistaken for document metadata.

## Three Layers

Metadata problems get attributed to the wrong layer, so the layers are named separately and each has one owner.

**Syntax layer.** A metadata block is YAML between `---` delimiters at the top of the file. This is the standard frontmatter convention and it is not modified, subsetted, or re-implemented. Parsing uses the `yaml` package, whose default is the YAML 1.2 core schema.

A hand-written parser is prohibited. The risk it carries is the one this repository spends the most effort eliminating: a document that means one thing to our reader and another to every standard tool. A divergence between our parse and the standard parse would be undetectable from inside the repository.

**Schema layer.** The allowed subset is flat scalars and arrays of strings: no nested mappings, no arrays of mappings, no anchors, no aliases, no multi-document streams. The subset is a constraint on what documents may contain, enforced by `zod` schemas, and `docs/documentation-model.md` owns it. The subset does not restrict the syntax layer; a document containing legal YAML outside the subset is a validation error, not a parse error.

Arrays of strings are inside the subset from the start because the vocabulary must be able to hold a multi-valued field without a second format change. This is a shape allowance, not authorization for any specific field.

**Parse layer.** YAML 1.2 core still performs implicit scalar typing. Verified behavior of `yaml` and `js-yaml` v4 at the 1.2 core schema: `2026-05-31` stays a string, `no` stays a string, `1.10` becomes the number `1.1`, and `0123` becomes the number `123`. The legacy YAML 1.1 timestamp and Norway coercions do not fire; numeric coercion does.

The mitigation is loud failure, not format restriction. Every field schema is `z.string()` or `z.array(z.string())`, so an implicitly typed number fails validation with the file, field, and received type named, rather than silently storing `1.10` as `1.1`. This follows the rule in `docs/engineering-doctrine.md` that a check throwing on the unknown is worth more than a tolerant one that silently passes what it does not understand. A field that must hold a numeric-looking value is quoted by its author; the failure message says so.

## Module Contract

One module owns the executable projection of the field contract.

It exposes:

- Parsing: returns the metadata mapping and body offset, or a typed parse failure. A document without frontmatter returns an explicit absent result rather than an empty mapping.
- Validation: returns errors for unknown fields, missing required fields, values outside a canonical set, wrong shapes and values implicitly coerced away from string.
- Per-type schemas: consumers compose the shared schemas rather than re-derive them.

It owns the vocabulary and per-type required and optional sets as data, mirroring `docs/documentation-model.md`. It owns nothing else: no plugin mechanism, no per-field custom validator beyond canonical-set and shape checks, no document classification, no index formatting. Classification stays with the type system projection; formatting stays with the index generator.

The three current scripts become one validator plus one generator, both importing this module and neither containing a metadata regular expression. Removal of the last header regular expression from those scripts is an acceptance predicate, not a stylistic preference: a surviving regular expression means a fourth definition of where a header is.

## Current Implementation Projection

`scripts/lib/doc-fields.mjs` exports `parseFrontmatter(content)`, `validateFields(type, fields)` and `fieldSchemas`. The documentation validator, specification lifecycle validator and index generator import that shared metadata reader.

## Generated Declaration

A machine-readable field declaration for consumers outside Node may be generated from `fieldSchemas` when a real consumer exists, following the generated-projection pattern already used by `docs/INDEX.md`: never hand-edited, regenerated by a script, and diffed in a `--check` mode so drift fails loudly.

No such consumer exists today, so none is generated. Building one now would be the abstraction-for-predicted-variants error the root `AGENTS.md` prohibits, and a hand-maintained declaration is prohibited in any case because it would be a second source of truth for the vocabulary.

## Migration

The legacy-header rewrite is mechanical, so its correctness requires equivalence evidence.

**Round-trip equivalence is the acceptance predicate.** Before the rewrite, every legacy metadata-bearing document's fields are extracted with the three current parsers. After the rewrite, the same documents are parsed with the new module. The migration is accepted only when the two field mappings are identical for every rewritten document, except that keys containing spaces are renamed to their enumerated kebab-case forms (`Status Changed` becomes `status-changed`) rather than by an inferred rule.

The equivalence claim covers format conversion only. Separately authorized semantic corrections are reported separately and are not claimed as round-trip-equal.

The completed migration separated the module change, corpus rewrite and legacy-reader removal so that a format change did not also change field rules. Legacy headers are no longer admitted. Frontmatter is required for every type with required metadata and whenever a document declares optional metadata. A type with neither required nor present metadata may remain frontmatter-free.

## Acceptance Predicates

- No metadata regular expression remains in any validator or generator; all metadata reads route through the module.
- One header definition exists, so no document can be valid to one check and invalid to another. The duplicate-status regression test is replaced by a frontmatter-level uniqueness guarantee, which YAML provides by rejecting duplicate keys.
- A field whose value implicitly coerces to a non-string fails validation, naming the file, field, and received type.
- A document with YAML outside the allowed subset fails validation with the offending construct named.
- A document without frontmatter fails validation when its type requires metadata, and any declared optional metadata must be in frontmatter; a type with neither required nor present metadata may remain frontmatter-free.
- Round-trip equivalence holds for all rewritten legacy metadata mappings in the corpus rewrite, with the space-to-kebab renames enumerated and the authorized semantic corrections above reported separately.
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
