---
status: Accepted
date: "2026-09-23"
decider: Engineer
---
# Decisions And Their Reasons Are Recorded Outside The Rule Owner

## Decision

Durable decisions are recorded as one immutable file per decision under docs/decisions/, a documentation type owned by the documentation model. The scope is every decision someone may later want to reverse: all engineer rulings, approved agent-initiated changes to governing design, and design decisions whose rejected alternatives are likely to return. Ordinary implementation choices are not recorded. Each record states date, decider, decision, reason, rejected alternatives, revisit trigger, supersession, and affected owners. New decisions are recorded when made; past ones are backfilled when needed, starting with a first batch chosen by a ruling census. Owners link the record beside the rule instead of writing an inline "engineer ruling" marker, so an owner statement that accepts a Safety Kernel limitation without a linked record is a detectable finding.

## Reason

The engineer observed that many decisions and their reasons are valuable but too small for Core and without a fitting specification, so the reasons were lost. The loss ran both ways: an Auditor could find rulings only by searching for a marker that existed in one specification, a Consultant once presented an agent's own method as an engineer non-negotiable, and the source of the 10–20% Strategic Programming heuristic was lost until an Auditor restored it. Separating "what is true now", which specifications may rewrite freely, from "why and by whom", which is append-only, lets owners be compressed without losing reasons and gives a later reader Chesterton's fence before removing a rule. A ruling census on 2026-09-23 found 31 durable rulings, of which 16 had the rule in an owner but the reason elsewhere or missing, and 3 had no owner.

Source: change record 202609231611190001-engineering_governance_landing, proposal, section Engineer Rulings, R-004.

## Rejected Alternatives

- Revision sections inside each specification. Rejected because they duplicate Git and grow with every edit rather than with every decision.
- Pure architecture decision records without a living owner. Rejected because a reader would have to walk a supersession chain to learn the current rule.
- A Decisions section at the end of each specification. Rejected because reasons are needed only when a rule is about to change, and large specifications already cost too much context to load.
- A per-owner decision log. Rejected because cross-owner decisions would be recorded twice.
- Recording every design decision, or backfilling all history. Rejected as cost without matching value.

## Revisit When

The number of records grows faster than the rules they support, a record type field proves unused, or a reviewer repeatedly cannot find the reason for a rule that has a record.

## Affected Owners

- docs/documentation-model.md
- docs/change-execution.md
- docs/decisions/README.md
