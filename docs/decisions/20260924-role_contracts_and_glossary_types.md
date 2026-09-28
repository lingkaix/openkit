---
status: Accepted
date: "2026-09-24"
decider: Engineer, on the writer's recommendation
---
# Role Contracts And The Glossary Are Not Governance Documents

## Decision

Role contracts under docs/roles/ are their own document type, ranked below the governance documents they apply, and the engineering glossary, the writing guide, and the harness reference are platform references. The governance set stays at three documents, so the rule that a fourth member promotes governance into its own directory is not triggered. This replaces the governance classification that rulings R-007 and R-008 had accepted for role contracts and the glossary.

## Reason

A role contract applies governance to one role rather than adding governing rules, so it belongs below the documents it applies, and a conflict is corrected in the role contract. A glossary owns the meanings of words, not rules, and every rule it names stays in its own owner. Classifying them as governance would also have moved the three governance documents into a new directory and rewritten every link to them without any gain in authority. The engineer accepted this recommendation on 2026-09-24.

Source: change record 202609231611190001-engineering_governance_landing, finding GOVLAND-FND-013 and proposal, section Choices Inside The Landing.

## Rejected Alternatives

- Role contracts and the glossary as governance documents, promoting governance into docs/governance/. Rejected for the reasons above.

## Revisit When

A role contract or the glossary needs to decide a rule that no governance document owns, or a seventh platform reference is proposed.

## Affected Owners

- docs/documentation-model.md
- docs/roles/README.md
- docs/glossary.md
