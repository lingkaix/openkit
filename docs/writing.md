---
status: Accepted
---
# Documentation Writing

This reference states how repository documents are written so that a reader, human or agent, finds the owner quickly, reads only what the task needs, and can rebuild the system from the documents and the admitted rebuild corpus. The decision and its reason are recorded in [a decision record](decisions/20260924-documentation_methods.md). The corpus boundary is owned by [Documentation Model](documentation-model.md#admitted-rebuild-corpus) and amended by [Reserved Audit Question Rulings](decisions/20261031-reserved_audit_question_rulings.md) and [DOC-FINAL Question Rulings](decisions/20261116-doc_final_question_rulings.md).

## Owns

- The writing rules below, which apply to every English repository document.
- The specification skeleton text rules and the five cross-corpus sweep rules (`R-SCHEMA`, `R-NUM`, `R-LABEL`, `R-DIGEST`, `R-TIME`).
- The size signal for a split review.

### Organize By Concept

A document covers one concept, mechanism, boundary, or method, and opens with one or two sentences that say what it owns; the generated index quotes that opening. When a concept grows too large, split it by concept, not by length: an entry document keeps the definition, the invariants, the ownership boundary, and a list of its child documents, and each child owns one self-contained part that can be read without its siblings. Do not cut a document into chapter files, because that scatters one concept's invariants across files, and relocations have silently broken in connecting sentences before.

Size is a signal, never a gate or validator cap ([DOC-FINAL Information Architecture](decisions/20261116-doc_final_information_architecture.md)). A typical specification is 15–60 KB. A specification above 80 KB after skeleton trimming, excluding registers, gets a duplication report naming which sections restate another owner so the decider can rule whether to split, rewrite, or keep it whole. Splitting an existing accepted document is its own change, and another context checks that every criterion survives.

### One Fact, One Place

State each fact in its owner and link to it everywhere else. A restated copy carries no authority, adds nothing while it agrees, and misleads once it drifts. The only permitted redundancy is a document projection that names its owner. Put a rule in its owner, the reason for it in a decision record, and its edit history in Git; do not add revision sections.

### Normative Text

Write normative sentences in domain terms that survive a rebuild in another language or stack. Do not make a rule depend on an implementation identifier, a file path, or a line citation; put navigation pointers in `## Implementation`, a local guide, or a code comment. Constrain boundaries and invariants rather than internal method, unless an internal decision carries weight, such as the ordering that durability depends on. When a technology choice is a decision, state its reason and when it could be replaced; otherwise leave it out of normative text. Write a boundary contract as preconditions, postconditions, and invariants, and illustrate a rule with examples when a reader could misapply it.

A specification prescribes architecture, module interfaces, and key technical details; leave out parts expected to change during implementation and evolution, such as dependency lists, file layout, helper choices, version pins without a stated decision, sizes, and round-by-round results ([decision](decisions/20261001-specifications_prescribe_architecture_not_implementation.md)).

### Specification Skeleton And Sweep Rules

Every specification follows the skeleton in [`docs/documentation-model.md`](documentation-model.md#skeleton):

- Open after `# Title` with one paragraph stating what the specification is the single owner of.
- In `## Scope`, state `Owns`, `Does not own` (at most 5 lines, each naming the owner), and `Core` links to the Core sections refined.
- In contract sections, use subject headings, verifiable `MUST`, `SHOULD`, and `MAY` sentences (one behavior per rule, examples subordinate), and tables for closed sets. A specification governing a live removal, migration, or rollout SHOULD state its current transition conditions in the relevant contract section; completed rollout and migration history ends.
- In optional `## Acceptance`, include only criteria that no contract sentence already carries (such as real-environment proof or verification level), and never name test files.
- In `## Implementation`, keep at most 10 lines of directory-level code pointers, with no behavior text and no `file:line` citations.
- In `## Implementation Gaps`, write `None.` when `implementation: Implemented`, or one line per unmet rule (`<rule> - <gap> - #<issue>`).
- In `## Decisions`, place links to decision records only.
- When removing ceremony, history, or projection sections (`Summary`, `Goals`, `Non-goals`, `Background`, `Alternatives Considered`, `Consequences`, `Risks`, completed `Rollout / Migration`, `Resolved Decisions`, `Open Questions`, `Deferred / Future Work`, `Links / Related Docs`, `Current Implementation Projection`, `Testing` lists), first move every sentence that carries a criterion (`MUST`, closed set, number, retained field, refusal, owner assignment) into a kept section (`DOC-015`). Rationale is not a criterion; keep at most one `"because"` clause beside a rule whose reason is not obvious, and turn open questions or deferred work into GitHub issues.

Apply these five sweep rules across every document ([DOC-FINAL Question Rulings](decisions/20261116-doc_final_question_rulings.md)):

- **Schemas, enums, and DDL (`R-SCHEMA`)**: Never restate a field set, enum, or DDL that an admitted contract artifact holds; name the artifact instead. List a closed protocol enum once, in `docs/specs/20261021-protocol_identifiers_and_enums.md`. Include DDL only where a reader needs it to read saved data.
- **Numbers (`R-NUM`)**: Every number is either a fixed contract constant or marked `"current default"` and equals the code value ([decision](decisions/20261002-specification_numeric_values_are_defaults.md)). When an experiential numeric limit, timeout, window, count, or size is stated as a current default or left to the implementation, state the property it protects; a number that defines a wire or retained-data format stays with its contract and evolution obligations. Remove any number that is neither.
- **Labels (`R-LABEL`)**: Include no tracker, plan, phase, or finding label unless the same document defines it; replace external labels with the owner link or the GitHub issue number.
- **Digests (`R-DIGEST`)**: `docs/specs/20261021-protocol_identifiers_and_enums.md` owns the single canonical digest form (RFC 8785 JSON + SHA-256). Each other owner lists only its inputs and links that specification; where code uses another form for a retained value, the owner specification states that form as a named exception.
- **Release timing labels (`R-TIME`)**: Core documents carry no release staging label. Staging lives in specification `Implementation Gaps` or the linked GitHub issue; only a release label that a decision record names as a contract boundary (such as `v0.1.0`) stays in Core.

### Sentences And Words

This section bases its rules on Simplified Technical English (ASD-STE100). Apply only the rules that this section states. Do not adopt its dictionary. Keep `docs/glossary.md` as the controlled vocabulary for technical names. Read the reason in [a decision record](decisions/20261012-ste_based_writing_rules.md).

Apply the first list to every new or changed sentence in an English repository document. Treat the decision records, the alternatives, the trade-offs, and the consequences as rationale wherever they occur. When the text is rationale, follow the first list except its two length targets. The two length targets are the procedural limit of about 20 words and the descriptive limit of about 25 words.

An L6 story (agentic story acceptance) hands a persona and an ask to its actor. Write that persona as a real user would say it. Write that ask as a real user would say it. Exempt that persona and that ask from both lists. Apply every other rule of the repository to that persona and to that ask.

When a change does not touch existing text, issue #218 brings that text into line.

- Keep a procedural sentence to about 20 words.
- Keep a descriptive sentence to about 25 words.
- Treat these lengths as targets.
- When a target would drop a required meaning, yield to precision.
- Put one instruction in one sentence.
- When a sentence has a condition, put the condition first.
- Use the imperative mood for a procedure.
- Use the active voice.
- Name the actor.
- Within one bounded context, give each technical term one meaning.
- Do not use a synonym for variety.
- Use a verb for an action.
- Do not use a noun phrase for an action.
- Do not use a noun cluster of more than three words.
- Keep the articles.
- Keep each paragraph short.
- Give each paragraph one topic.
- Use a list for a sequence.

Except for that persona and that ask, apply the next list to every English repository document.

- One idea per sentence, one topic per paragraph. A sentence over about forty words usually holds two ideas.
- Prefer positive statements and name who acts. Use a negative definition only where the exclusion is the point.
- Use the terms of `docs/glossary.md` with their fixed phrases. Do not coin a term; when no classic term or plain phrase fits, mark the new term project-specific and add it to the glossary in the same change.
- Avoid filler that adds no information: stacked qualifiers, empty summary sentences, restating the previous sentence, vague intensifiers such as robust, comprehensive, seamless, or leverage, and "ensure" without saying what must hold.
- Explain every code, abbreviation, or label on first use, or replace it with its meaning.
- Headings name what the section decides.

### Rewriting Without Loss

A rewrite, compression, split, or relocation must keep every criterion, meaning any statement whose absence or change could alter implementation, tests, failure, recovery, ownership, or responsibility, including every qualifier that bounds it. Validators pass through a lost qualifier, so the writer lists every criterion it moved, merged, or reworded with its old and new location, and another context checks the diff against that list and against the old text. The writer does not accept its own rewrite.

### Checking Documents

Structural validators check types, fields, links, and generated projections. Specification mutation checks that a clause's derivations would notice a change, document ablation asks whether a clause is needed at all, and a sampled rebuild probe checks the whole; `docs/specs/20260719-verification_calibration.md` owns those instruments. A terminology check over the avoid list in `docs/glossary.md` may be tried later; it would check only that list and cross-context collisions, not style.

## Does Not Own

- Document types, fields, the specification skeleton, precedence, and the reading protocol: `docs/documentation-model.md` owns them.
- Vocabulary: `docs/glossary.md` owns it.
- Specification discovery: `docs/specs/README.md` owns it.
- Change-record content: `docs/change-execution.md` owns it.
- The language rule and the rule against line breaks inside a sentence or paragraph: root `AGENTS.md` owns them, and [a decision record](decisions/20260924-line_wrapping_belongs_to_the_reader.md) holds the second rule's history.
- When documents must change with behavior: root `AGENTS.md` owns the doc-first rule.

## Judgments

- Documents are the project's primary source of truth, so their test is whether an agent could rebuild a conforming system from them and the admitted rebuild corpus after the implementation is deleted. Rests on: the engineer's definition of success, recorded in `docs/decisions/20260923-documentation_rebuild_test.md` and amended by `docs/decisions/20261031-reserved_audit_question_rulings.md`. Overturned by: a rebuild probe that succeeds while these rules are ignored, or fails while they are followed.
- A long document costs every reader its full length even when the task needs one part, and agents read whole files. Organizing by concept with links lets a reader stop early. Rests on: agents loading whole files into bounded context windows when a task touches one part. Overturned by: evidence that readers of split documents miss criteria more often than readers of long ones.

## Related Documents

- `docs/documentation-model.md`
- `docs/glossary.md`
- `docs/specs/README.md`
- `docs/roles/writer.md`
