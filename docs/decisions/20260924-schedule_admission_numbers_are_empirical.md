---
status: Accepted
date: "2026-09-24"
decider: Engineer
supersedes: docs/decisions/20260909-schedule_admission_attempts.md
---
# Schedule Admission Numbers Are Empirical Defaults

## Decision

Each scheduled occurrence receives at most three committed admission-attempt outcomes, the initial attempt and two retries on later five-second scans. An occurrence still unresolved ten minutes after its original scheduled instant expires. Once admitted, it is never resubmitted because dispatch or execution later fails. The recurring event triggers specification owns the rule.

## Reason

The engineer replied explicitly to a scheduling clarification on 2026-09-09 with these values. On 2026-09-24 the engineer explained, summarized here from Chinese, that the numbers are empirical: they were set from experience and from simulating the user's experience, and the project should allow them to change later, possibly as a user setting.

Source: the engineer's answer of 2026-09-24 to the landing's report, summarized above and noted in change record 202609231611190001-engineering_governance_landing; the original values are in change record 202609091207510001-deployment_recurring_design, Intent Epoch 2.

## Rejected Alternatives

- Resubmitting accepted work after an execution failure, and replaying worker effects. Rejected by the engineer.
- User-configurable retry counts or deadlines now. Left outside the current contract; the engineer expects to allow it later.

## Revisit When

Observed use shows the values serve users poorly, or a change makes the counts or the deadline configurable.

## Affected Owners

- docs/specs/20260711-scheduler_recurring_event_triggers.md
