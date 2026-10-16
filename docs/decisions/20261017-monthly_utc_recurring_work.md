---
status: Accepted
date: "2026-10-17"
decider: Engineer
---
# Bounded Monthly UTC Recurring Work

## Decision

Accept the #194 bounded monthly UTC Worker-admission slice: one explicit UTC hour, minute and second on a day from 1 through 28 in every Gregorian month. Reuse the existing recurring definition, occurrence, expired range, serialized scanner, existing Thread, Worker admission and immutable responsible automation actor. Keep existing missed, overlap, deadline, attempt, restart, Audit, unknown-result and no-repair publication rules. The complete monthlyUtc shape is mutually exclusive with the existing intervalSeconds shape; fixed retained data remains usable without a migration, shim or artificial interval.

No other zone, day 29 through 31, last-day rule, calendar expression, new runner, new record family or new API family is accepted. Recurring Goal creation is an open follow-up only. This decision defines no calendar-to-Goal action, changes no Goal wake semantics and authorizes no Goal creation, Plan approval or completion claim.

## Reason

A fixed elapsed duration cannot express a calendar month. Days 1 through 28 have exactly one valid Gregorian date in every month, and literal UTC requires no local-time conversion, DST gap or fold policy. The existing recurrence lifecycle already owns the bounded admission problem; a second runner or Goal timer would duplicate authority. Broader calendar or recurring Goal behavior needs its own accepted product decision.

## Source And Owner

The engineer explicitly accepted this bounded scope in the active engineering session on 2026-10-17. The external calendar-owner proposal supplied independent analysis, not authority. [Recurring Triggers](../specs/20260711-scheduler_recurring_event_triggers.md#monthly-utc-cadence) owns its complete criteria. [Durable Scheduler](../specs/20260703-durable_scheduler_design.md) and [Interrupted Recurring Publication](20261016-recurring_publication_inspection.md) retain their existing boundaries.
