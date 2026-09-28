---
status: Accepted
date: "2026-09-28"
decider: Engineer
---
# Maintainer Context And Technical Debt Traceability

## Decision

The purpose of documenting functions, interfaces, and other code entities is to preserve context for future maintainers. Code, comments, tests, and architecture documents form a collaboration medium across time. Non-obvious design decisions, compatibility constraints, known defects, and temporary solutions must record their reasons, affected scope, potential risks, and removal conditions; a lasting decision states when removal does not apply instead of inventing an expiry.

Technical debt must link to a traceable task, using existing tracking rather than requiring a new system. Key architectural decisions require engineer confirmation: their rules belong in Core or specifications, and decision records preserve rationale and alternatives under the existing documentation model. This clarification preserves the language-standard entity-documentation requirement and does not authorize compatibility mechanisms prohibited by the data-compatibility rule (NONNEG-001).

## Reason

The engineer clarified on 2026-09-28 that comments are intended to carry otherwise lost maintenance context, not to satisfy a mechanical comment count. Without reasons, impact, risks, and removal conditions, later maintainers cannot distinguish an essential constraint from a temporary workaround or safely retire technical debt.

## Rejected Alternatives

- Restate code syntax as sufficient documentation: it does not preserve design context.
- Leave technical debt as an unlinked TODO: it does not provide accountable follow-up.
- Treat a comment or decision record as a substitute for an engineer-confirmed architectural owner: existing authority rules still apply.
- Require every permanent decision to have an invented deletion deadline: record non-applicability when appropriate.

## Revisit When

Observed maintenance failures show missing context, or the engineer changes debt tracking or documentation responsibilities.

## Affected Owners

- AGENTS.md owns execution requirements for code documentation and debt traceability.
- docs/engineering-doctrine.md explains the maintenance purpose.
- docs/documentation-model.md continues to own the distinction between behavioral owners and decision rationale.
