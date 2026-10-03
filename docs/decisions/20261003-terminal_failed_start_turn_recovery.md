---
status: Accepted
date: "2026-10-03"
decider: Coordinator, under the engineer's standing delegation to decide in the engineer's absence, on an independent Consultant's analysis
---
# Terminal Failed-Start Turn Recovery

## Decision

The Coordinator adopted the narrowed failed-start recovery rule in [Worker Turn Reliability Envelope](../specs/20260531-worker_turn_reliability_envelope.md#worker-turn-envelope). Ordinary post-listener scheduler maintenance invokes the existing Turn lifecycle owner for a nonterminal worker Turn whose sole exact lease is failed with turn-start-failed and needs-evidence, complete agreeing lineage, and no checkpoint, final status, competing owner, or contradictory binding. Settlement requires exact recorded definite cleanup or positively proved unanchored pre-effect ownership. The Turn fails, its non-reusable AgentSession closes, and existing terminal publications complete. Unproved outcome delivery remains delivery-unknown without resubmission. Missing or contradictory proof remains recovery_required. No interrupt change, recovery state, or runner is added.

## Reason

Restart maintenance cleaned terminal-lease orphans without settling their product Turns, leaving a Thread unable to admit new work. The Consultant narrowed the broader proposal to the demonstrated failed-start signature. Exact cleanup proves that the attempt cannot continue; it does not prove that no worker ran or external effect occurred. An absent backend row alone is also insufficient: the unanchored pre-effect boundary needs positive ownership proof. Reusing the product lifecycle owner preserves publication retry without reopening execution.

Source decision: temp/comm-redesign/engineer-queue.md, entry "Stale failed-start worker Turn after restart", dated 2026-10-03. Source analysis: temp/interface-unification/reports/stale-turn/consult-report.md. Landing commit: 5f56c8c0239909635f0c1e6b50b5f3146b9359ed. These are provenance references, not behavioral authority.

## Rejected Alternatives

- Settlement of every terminal-lease Turn: the Consultant narrowed eligibility to the existing failed-start signature to avoid describing arbitrary lost execution as a start failure.
- A product-only interrupt command: it requires the same proof and adds another lifecycle entry point without solving a case that maintenance cannot settle.
- A new recovery table or runner: the existing maintenance and terminal publication owners already supply the needed path.

## Revisit When

None recorded.

## Affected Owners

- [Worker Turn Reliability Envelope](../specs/20260531-worker_turn_reliability_envelope.md)
- [Durable Scheduler Design](../specs/20260703-durable_scheduler_design.md)
- [Pending Requests](../specs/20260930-pending_requests.md)
