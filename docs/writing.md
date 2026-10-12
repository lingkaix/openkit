---
status: Accepted
---
# Documentation Writing

This reference states how repository documents are written so that a reader, human or agent, finds the owner quickly, reads only what the task needs, and can rebuild the system from the documents alone. The decision and its reason are recorded in [a decision record](decisions/20260924-documentation_methods.md).

## Owns

- The writing rules below, which apply to every English repository document.
- The soft size trigger for a split review.

### Organize By Concept

A document covers one concept, mechanism, boundary, or method, and opens with one or two sentences that say what it owns; the generated index quotes that opening. When a concept grows too large, split it by concept, not by length: an entry document keeps the definition, the invariants, the ownership boundary, and a list of its child documents, and each child owns one self-contained part that can be read without its siblings. Do not cut a document into chapter files, because that scatters one concept's invariants across files, and relocations have silently broken in connecting sentences before.

A document longer than about 6,000 words, or one that an agent cannot read together with the code it governs, triggers a split review. The trigger asks a question; it is not a gate, and the answer may be that the document stays whole. Splitting an existing accepted document is its own change, and another context checks that every criterion survives.

### One Fact, One Place

State each fact in its owner and link to it everywhere else. A restated copy carries no authority, adds nothing while it agrees, and misleads once it drifts. The only permitted redundancy is a document projection that names its owner. Put a rule in its owner, the reason for it in a decision record, and its edit history in Git; do not add revision sections.

### Normative Text

Write normative sentences in domain terms that survive a rebuild in another language or stack. Do not make a rule depend on an implementation identifier, a file path, or a line citation; put navigation pointers in a clearly marked implementation projection section, a local guide, or a code comment. Constrain boundaries and invariants rather than internal method, unless an internal decision carries weight, such as the ordering that durability depends on. When a technology choice is a decision, state its reason and when it could be replaced; otherwise leave it out of normative text. Write a boundary contract as preconditions, postconditions, and invariants, and illustrate a rule with examples when a reader could misapply it.

A specification prescribes architecture, module interfaces, and key technical details; leave out parts expected to change during implementation and evolution, such as dependency lists, file layout, helper choices, version pins without a stated decision, sizes, and round-by-round results. Agents apply every normative sentence literally, so over-specific text causes errors and stalls; [the decision record](decisions/20261001-specifications_prescribe_architecture_not_implementation.md) explains this scope. A numeric limit, timeout, window, count, or size chosen from experience is a current default: state the property it protects, and either leave the number to the implementation or name it marked as the current default; a number that defines a wire or persisted-data format stays with its contract ([decision](decisions/20261002-specification_numeric_values_are_defaults.md)).

### Sentences And Words

This section bases its rules on Simplified Technical English (ASD-STE100). Apply only the rules that this section states. Do not adopt its dictionary. Keep docs/glossary.md as the controlled vocabulary for technical names. Read the reason in [a decision record](decisions/20261012-ste_based_writing_rules.md).

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
- Use the terms of docs/glossary.md with their fixed phrases. Do not coin a term; when no classic term or plain phrase fits, mark the new term project-specific and add it to the glossary in the same change.
- Avoid filler that adds no information: stacked qualifiers, empty summary sentences, restating the previous sentence, vague intensifiers such as robust, comprehensive, seamless, or leverage, and "ensure" without saying what must hold.
- Explain every code, abbreviation, or label on first use, or replace it with its meaning.
- Headings name what the section decides.

### Rewriting Without Loss

A rewrite, compression, split, or relocation must keep every criterion, meaning any statement whose absence or change could alter implementation, tests, failure, recovery, ownership, or responsibility, including every qualifier that bounds it. Validators pass through a lost qualifier, so the writer lists every criterion it moved, merged, or reworded with its old and new location, and another context checks the diff against that list and against the old text. The writer does not accept its own rewrite.

### Checking Documents

Structural validators check types, fields, links, and generated projections. Specification mutation checks that a clause's derivations would notice a change, document ablation asks whether a clause is needed at all, and a sampled rebuild probe checks the whole; docs/specs/20260719-verification_calibration.md owns those instruments. A terminology check over the avoid list in docs/glossary.md may be tried later; it would check only that list and cross-context collisions, not style.

## Does Not Own

- Document types, fields, precedence, and the reading protocol: docs/documentation-model.md owns them.
- Vocabulary: docs/glossary.md owns it.
- Specification body guidance, including kinds in practice and the Current Implementation Projection section: docs/specs/README.md owns it.
- Change-record content: docs/change-execution.md owns it.
- The language rule and the rule against line breaks inside a sentence or paragraph: root AGENTS.md owns them, and [a decision record](decisions/20260924-line_wrapping_belongs_to_the_reader.md) holds the second rule's history.
- When documents must change with behavior: root AGENTS.md owns the doc-first rule.

## Judgments

- Documents are the project's primary source of truth, so their test is whether an agent could rebuild a conforming system from them after the implementation is deleted. Rests on: the engineer's definition of success, recorded in docs/decisions/20260923-documentation_rebuild_test.md. Overturned by: a rebuild probe that succeeds while these rules are ignored, or fails while they are followed.
- A long document costs every reader its full length even when the task needs one part, and agents read whole files. Organizing by concept with links lets a reader stop early. Rests on: required governance reading of about 20,000 words in September 2026 and specifications of up to 51,229 words. Overturned by: evidence that readers of split documents miss criteria more often than readers of long ones.

## Related Documents

- docs/documentation-model.md
- docs/glossary.md
- docs/specs/README.md
- docs/roles/writer.md
