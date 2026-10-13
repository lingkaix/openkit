---
id: accounted-outcome-during-restart-or-update
title: Finish work that is interrupted by a restart or an update
persona: Maintainer posting one note on a designated issue
entrypoint: web
default_tool: playwright
timeout_seconds: 1800
requires_real_provider: true
requires_real_codex: false
contracts: docs/specs/20260531-worker_turn_reliability_envelope.md, docs/specs/20260910-app_update_delivery.md, docs/specs/20260930-pending_requests.md, docs/specs/20260704-worker_mcp_tool_supply.md, docs/specs/20260703-worker_agent_capability.md
---

## Intent

Persona: A maintainer of the designated issue.

Ask: Post this note on the designated issue through a worker, and tell me whether it was posted.

## Starting World

One designated issue exists. The stage manager supplies one note for this attempt. One Worker is available. That Worker can use the governed GitHub supply.

## Setup

The stage manager supplies the provider, the GitHub authority, the designated issue, and the note through the private parameter file. The stage manager does not put a credential value in the story or in the ask. The stage manager records which perturbation it applied.

## Outcome Predicates

- Channel outside-in, tier required. The actor receives a terminal result for the Task that this ask produces. That result says whether the note was posted, and a fresh GitHub read agrees with that statement. The GitHub read is the oracle, not the record.
- Channel inside-out, tier required. The Pending Request for the write that this ask's Task produces retains the actor's grant for exactly that comment, and it has one recorded execution outcome. The product records hold at most one executed write for that request. The records are the Pending Request and the CapabilityCall for that write. `docs/specs/20260930-pending_requests.md` owns the grant and the execution outcome. `docs/specs/20260703-worker_agent_capability.md` owns the CapabilityCall. `docs/specs/20260704-worker_mcp_tool_supply.md` owns the governed GitHub route.
- Channel outside-in, tier required. A fresh GitHub read shows at most one comment that carries the attempt's note. The GitHub read is the oracle, not the record.

## Perturbations

The stage manager applies one App restart or one App update while the Task is underway. The perturbation starts after admission and before the terminal result. One run applies exactly one of the two. The stage manager records which one it applied. The actor does not receive that procedure.

## Integrity Invariants

terminal-turn-consistency

## Evidence To Collect

The stage manager keeps the actor's terminal result and the fresh GitHub read of comments on the designated issue. The stage manager keeps the Pending Request, the actor's grant for that comment, its recorded execution outcome, and the CapabilityCall for the write. The stage manager records which perturbation it applied.

## Cleanup

The stage manager does not delete the comment before the judge finishes. The stage manager removes attempt-owned client state and does not remove the designated issue.

## Failure Triage Notes

- A product failure means two comments carry the note, the product records show two executed writes, or the terminal statement disagrees with the GitHub read.
- An environment failure means GitHub authority, the provider, or the designated issue is missing, or the perturbation never becomes observable.
- A tool failure means the browser-control tool fails on its own.
- An inconclusive result means the Task has no terminal result, or the write outcome cannot be proved.
- The likely lower layer is the restart scenario in `docs/specs/20260531-worker_turn_reliability_envelope.md`.
