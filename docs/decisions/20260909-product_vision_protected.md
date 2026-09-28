---
status: Accepted
date: "2026-09-09"
decider: Engineer
---
# The Product Vision Changes Only On The Engineer's Explicit Request

## Decision

Agents must not modify the product vision document unless the engineer explicitly requests changes to that document; general design, architecture, implementation, or documentation-alignment requests do not authorize editing it. The English clause is the primary agent's projection of the engineer's requirement. Root AGENTS.md owns the rule.

## Reason

The engineer discarded earlier agent edits to the product vision and required that it stay untouched unless the engineer asks for a change to it. No further reason was recorded. Inferred, not stated: the vision records the engineer's own intent, which agents interpret but do not author.

Source: change record 202609090046400001-generative_apps_mvp, Intent Epoch 1.

## Rejected Alternatives

- Aligning the vision with other documents as part of ordinary documentation work. Rejected; the engineer discarded such edits.

## Revisit When

When the engineer asks for a change to the product vision.

## Affected Owners

- AGENTS.md
