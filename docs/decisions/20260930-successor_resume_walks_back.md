---
status: Accepted
date: "2026-09-30"
decider: Engineer
---
# Successor Resume Walks Back To The Nearest Recorded Pair

## Decision

When NanoCore admits a successor AgentSession on a Thread, it selects the resume pair from the Thread's other AgentSessions ordered by creation time, newest first. The successor presents the pair of the nearest AgentSession in that order whose ready proof was recorded, skipping any newer AgentSession that has none. When no AgentSession of the Thread has a recorded pair, the successor opens a new native conversation. Two AgentSessions with equal creation times along that walk leave the order unproved, and admission fails closed with `recovery_required`.

A predecessor without a recorded pair is either one that failed before it established a native conversation, or one whose accepted proof was lost. Both are skipped. Skipping is safe for continuity because every resumed open must prove the exact digest of the pair it presented, so the recorded pairs of one Thread identify the same native conversation, and the native state a skipped predecessor added to that conversation stays in the retained volume under the same reference.

## Reason

The engineer chose this rule on 2026-09-30 from three options presented after the independent round 2 review of the lifecycle slices (finding F3): walk back to the nearest recorded pair; bypass a failed predecessor only when a new durable fact proves it accepted no native reference, and fail closed otherwise; or fail closed whenever the predecessor has no pair and an earlier pair exists. The chosen rule needs no new durable state and keeps a Thread usable after a successor that failed before `session.open`, such as a Sandbox that did not start. Strict fail-closed would leave such a Thread permanently unusable, and the durable-evidence option adds a lifecycle fact that no current need beyond this case requires.

Accepted residual risks, stated when the engineer ruled:

- If the first AgentSession of a Thread established a conversation and its proof was lost in the window between the SQLite result commit and the AgentSession write, the successor opens a new conversation rather than continuing the lost one.
- Order rests on NanoCore's recorded creation times; a clock that moves backwards can misorder AgentSessions. Equal times fail closed, unequal misordered times do not.

Source: engineer answer of 2026-09-30 in the agent communication redesign session.

## Rejected Alternatives

- Bypass a failed predecessor only with durable evidence that it accepted no new native reference, and fail closed otherwise. It needs a new durable lifecycle fact for one recovery case.
- Fail closed whenever the predecessor has no recorded pair and an earlier pair exists. Any failure before `session.open` would end the Thread.
- Select the latest AgentSession with a recorded pair by any other order, such as identifier order. Identifiers carry no ordering authority.

## Revisit When

A proof is observed lost outside the stated window, a runtime switch operation lets one Thread hold pairs of different runtimes, or AgentSession creation order needs a guarantee stronger than NanoCore's clock.

## Affected Owners

- docs/specs/20260704-agent_session_continuity.md
