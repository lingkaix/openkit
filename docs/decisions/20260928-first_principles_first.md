---
status: Accepted
date: "2026-09-28"
decider: Engineer
---
# First Principles Lead The Execution Contract

## Decision

Root AGENTS.md states First Principles first, as FIRST-001. Discussions, decisions, and designs start from essential needs, outcomes, and genuine constraints, then derive a justified design and a practical implementation. Current system structure is evidence and must not constrain the design merely because it already exists. First Principles is a standard for reasoning, not a grant of authority: a change to an accepted owner still follows AUTH-001 and the existing approval authority. FIRST-001 is the only statement of the principle.

## Reason

The engineer explicitly requested this on 2026-09-28: the best design should follow the fundamental need rather than the accidental shape of the current system. The engineer explained, translated from Chinese, that engineers and agents discuss solutions, make decisions, and modify and update Core and specification documents together, so all of that work must be reasoned from first principles, and that first principles does not give an agent permission to exceed its authority.

## Rejected Alternatives

- Let existing implementation or compatibility dictate the target design: rejected as contrary to First Principles.
- Treat First Principles as permission for speculative redesign or unilateral authority changes: existing scope, evidence, and approval rules remain applicable.
- State the principle in both FIRST-001 and NONNEG-001: rejected on 2026-09-28 because the two statements differed in strength, one qualified by "merely" and one not.

## Revisit When

An engineer explicitly revises this engineering principle based on observed outcomes.

## Affected Owners

- AGENTS.md
