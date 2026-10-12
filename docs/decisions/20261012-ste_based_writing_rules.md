---
status: Accepted
date: "2026-10-12"
decider: Engineer
---
# Local Sentence Rules Based On Simplified Technical English

## Decision

The repository adopts the local list in docs/writing.md. That list is based on Simplified Technical English (ASD-STE100). The repository does not adopt the dictionary of that standard. docs/glossary.md is the controlled vocabulary for technical names. The first list applies to every new or changed sentence in an English repository document. Rationale follows the first list except its two length targets. Those targets are the procedural limit of about 20 words and the descriptive limit of about 25 words. Rationale is decision records, alternatives, trade-offs, and consequences, wherever they occur. The persona and the ask that an L6 story hands to its actor are exempt from both lists. A writer must write that persona and that ask as a real user would say them. Every other rule of the repository still applies to that persona and that ask. When a change does not touch existing text, issue #218 brings that text into line.

## Reason

Agents of several model families read the rules literally. Those agents must read one text the same way. These rules reduce ambiguity. On 2026-10-12 the engineer agreed to the coordinator's six-point proposal from the second round of the L6 story discussion. The engineer said 「你给我的六点回复，我都同意。」 The next sentence is a translation. I agree with all six points in your reply. On this decision the engineer said 「第三点我同意。 不过需要提交一个issue，就是对旧文档的审计与改写、修复与更新。最终我们是需要把我们所有的文档都整理干净，统一。」 The next three sentences are a translation. I agree with the third point. But we need to file an issue for the audit and rewrite, the repair and the update of the old documents. In the end we need to tidy all of our documents and make them uniform. The proposal has six points. The first point proposes an operator story that updates a deployment from the previous published release through the built-in update tools, with continuity and rollback checks. That story removes the privileged exact-source deploy from the release flow. The second point limits the actor's channels and not the actor's intelligence. The actor may use general abilities through public surfaces. The actor must not use a privileged channel. The third point reduces the product-side cause and not the agent trajectory. It allows an explicit outcome of not reducible, with a reason. The fourth point puts integrity invariants in a read-only product check. It keeps the test side to one generic evidence collector over public operations. The fifth point adopts Simplified Technical English writing rules without that standard's dictionary. It keeps docs/glossary.md as the controlled vocabulary. It leaves the persona and the ask in natural user speech. It applies the rules to new and touched normative and procedural text. It keeps rationale plain and free of the sentence-length targets. It amends Sentences And Words in docs/writing.md. The sixth point sets a catalog of ten stories.

## Rejected Alternatives

- The Simplified Technical English dictionary. Rejected because the dictionary is unnecessary. docs/glossary.md is the controlled vocabulary.

## Revisit When

The engineer did not state a separate reopen trigger. The coordinator proposes the triggers that follow. Reopen this decision if agents of several model families do not read one text the same way. Reopen this decision if a sentence-length target repeatedly drops a required meaning. Reopen this decision if docs/glossary.md no longer supplies the controlled vocabulary.

## Affected Owners

- docs/writing.md
- docs/glossary.md
- docs/specs/20260529-l6_story_acceptance.md
- English repository documents, for new and changed sentences, and for untouched text that issue #218 brings into line
