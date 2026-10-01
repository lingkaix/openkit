---
status: Accepted
date: "2026-10-01"
decider: Engineer
---
# Specifications Prescribe Architecture, Interfaces, And Key Details

## Decision

Record the engineer's ruling on specification scope and extend the Normative Text section of docs/writing.md to tie that scope to how agents read documents. After the current A2 end-to-end run passes, slim the specifications touched by the agent communication redesign to architecture, module interfaces, and key technical details. Move implementation narrative to local READMEs or code comments. A writer produces that follow-up, and an independent reviewer checks it item by item so no criterion is lost under DOC-015.

## Reason

On 2026-10-01 the engineer said, translated from Chinese: "Sometimes, when writing the various documents, we pin specific technical details too tightly. Agents then follow the rules to the letter, which causes errors and lost efficiency. Our technical documents should describe and prescribe only the design architecture, the module interfaces and the key technical details. The parts that need to be dynamic and flexible during implementation, and during later system development and evolution, should not be hard-coded in the documents."

For example, docs/specs/20260528-core_client_boundary.md said the App API schema package "depends only on `@openkit/protocol` and `zod`": a current dependency enumeration rather than the governing runtime-neutral, browser-safe invariant. The enumeration had been stale for months, and a builder fixing a Web white screen had to stop for an authority ruling.

Agents treat every normative sentence of an accepted owner as binding. An over-specific sentence therefore becomes a stop point or a wrong constraint even when the intended boundary still holds.

## Rejected Alternatives

- Slim every Core and specification document at once. The engineer chose a follow-up limited to the redesign specifications after A2 passes, with an independent item-by-item criterion check.
- Record the ruling only. The engineer also chose an amendment to docs/writing.md so the ruling guides future writing and agent reading.

## Revisit When

Evidence shows that this scope omits a technical decision needed to preserve a governing criterion, or over-specific normative text continues to cause errors and stalls despite applying it.

## Affected Owners

- docs/writing.md
- The specifications touched by the agent communication redesign, to be slimmed as follow-up work after the current A2 end-to-end run passes.
