---
status: Superseded
superseded-by: docs/decisions/20260924-schedule_admission_numbers_are_empirical.md
date: "2026-09-09"
decider: Engineer
---
# A Scheduled Occurrence Gets Three Admission Attempts Within Ten Minutes

## Decision

Each scheduled occurrence receives at most three committed admission-attempt outcomes, the initial attempt and two retries on later five-second scans. An occurrence still unresolved ten minutes after its original scheduled instant expires. Once admitted, it is never resubmitted because dispatch or execution later fails. The recurring event triggers specification owns the rule.

## Reason

The engineer replied explicitly to a scheduling clarification: adopt three total admission attempts, retry on the next scan, never resubmit accepted work solely because execution failed, and expire unadmitted work ten minutes after its scheduled time. Why the counts are three and ten was not recorded. Ask the engineer before changing the numbers, and record the answer in a new record that supersedes this one.

Source: change record 202609091207510001-deployment_recurring_design, Intent Epoch 2.

## Rejected Alternatives

- Resubmitting accepted work after an execution failure, and replaying worker effects. Rejected by the engineer.
- User-configurable retry counts or deadlines. Left outside the contract.

## Revisit When

Not recorded.

## Affected Owners

- docs/specs/20260711-scheduler_recurring_event_triggers.md
