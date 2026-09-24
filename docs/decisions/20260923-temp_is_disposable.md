---
status: Accepted
date: "2026-09-23"
decider: Engineer
---
# Temporary Material Is Disposable And Its Value Is Harvested

## Decision

Material under temp/ may be lost at any time. Its value is protected by harvesting it into committed homes in this repository at fixed moments, not by backing temp/ up: when a line of work is parked, at checkpoints and closeout, and at the triage that accompanies a release-boundary or requested audit. Harvest uses existing homes only. An open question with an owner goes to that owner's open-questions or deferred section, indexed from the roadmap when it matters. Material tied to a change goes to that change record's findings.md, and its distilled rationale, alternatives, and objections go to the change's proposal.md. Decisions go to decision records, which hold settled matters only. A divergent discussion with neither owner nor change keeps only its temp status header and accepts the risk of loss. Every temp work package carries a fixed status header of at most ten lines: status (active, parked, harvested, or abandoned), the question it answers, settled items linked to decision records, open questions, next step, reopen condition when parked, related change record, and last update date. Harvested text is public, so host details, credentials, and unverified inference are removed first. A one-time triage of the existing temp/ directories is proposed by a read-only delegate and every deletion is confirmed by the engineer.

## Reason

Discussions diverge, many stop half-way, and writing a specification from them always loses information, mainly reasons, rejected alternatives, and unresolved questions. Those have their own homes once decision records exist, so a specification can state conclusions only. Harvesting continuously, with status markers and rulings written down when made, avoids a heavy final reorganization. The engineer rejected making this repository depend on a parent or second repository, because another machine's setup cannot be required to have one; and because this repository is public, raw discussion cannot be committed as it is.

Source: change record 202609231611190001-engineering_governance_landing, proposal, section Engineer Rulings, R-005.

## Rejected Alternatives

- Committing raw discussion records. Rejected because commits here are publication and raw records contain internal judgment and host details.
- Storing temp material in a parent or separate repository as a project rule. Rejected because the rule would fail on a machine without that repository; the engineer placed any such backup outside this discussion's scope.
- A periodic cleanup calendar. Rejected in favor of fixed events.

## Revisit When

A harvested home repeatedly lacks information that a later change needed, or the one-time triage shows that parked packages are never reopened.

## Affected Owners

- docs/change-execution.md
- docs/decisions/README.md
