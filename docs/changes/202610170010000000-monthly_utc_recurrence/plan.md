---
type: change-plan
status: in-progress
date: 2026-10-17
---
# Bounded Monthly UTC Recurrence

## Complete Dispatch Checkpoint

The primary assigned approved #194 monthly UTC recurrence on 2026-10-17. The engineer accepted explicit UTC time on days 1 through 28, reusing existing definition, occurrence, scanner and Worker admission into an existing Thread. Existing missed, overlap, restart, attempt, immutable actor, current authority, Audit and no-repair rules remain binding. No other zones, days 29 through 31, last-day rules, new runner, record family or API are authorized. Recurring Goal creation is open follow-up only; do not design, implement or claim it, and do not change Goal wake semantics.

This helper works in go-calendar on lane/go-calendar from committed lane/go-integration 96943978a0d1d853cfbf629d1a32c9d3f63aecfd. No P14 candidate is merged. Generative delivery ece32aea and candidate 7798005e stay frozen. The helper owns one local cadence calculation module and its tests, App API automation schemas/tests, recurring-records and tests, recurrence owner amendment, this change record and the accepted decision. AutomationStore and its tests remain primary-owned until explicit handoff after the primary's Audit vocabulary correction. Do not edit its files before that handoff. The recurrence helper owns portability and registry integration. The primary owns shared production composition, canonical publication, Audit and export source, migration/closure, generated outputs and shared chat. Web monthly controls require a later handoff after server cadence acceptance; existing Automation Web source remains frozen. No host service, a1/a2, provider, secret, release publication, remote CI, push or landing action is authorized. No nested helper or model switch is permitted.

The complete monthlyUtc object contains literal zone UTC and integer dayOfMonth, hour, minute and second. It is mutually exclusive with intervalSeconds. Existing fixed shapes remain unchanged. A complete paused timing edit replaces the other shape atomically. Monthly snapshots and exact ranges retain their authored rule. The primary agreed this field realization and authorized direct shape coordination with the recurrence helper; portability remains inert. Identifiers use current APIs; no formatter, private allocation, relaxed validator or candidate P14 mechanism is introduced.

## Owners And Method

[Recurring Triggers](../../specs/20260711-scheduler_recurring_event_triggers.md), [Durable Scheduler](../../specs/20260703-durable_scheduler_design.md), [Schema Evolution](../../specs/20260703-schema_evolution_record_envelope.md), and [No Repair](../../decisions/20261016-recurring_publication_inspection.md) retain authority. [Monthly UTC Ruling](../../decisions/20261017-monthly_utc_recurring_work.md) records the engineer decision. Read the current root/builder/local guides, backlog lane brief and Express landing/P21 scope, external calendar proposal and affected Web contract. The primary owns express landing after integration and independent exact-head review.

Start with a lowest-sufficient schema regression that fails because monthly creation is absent, then implement the accepted owner and pure calendar calculation. After store handoff, cover exact resume, successor, expired prefix/count, bounded SQL selection, immutable snapshots/cursors, pause/edit/delete sealing, rollback and inherited lifecycle behavior. Prove January 28 to February 28 to March 28 once through actual local native admission and Core/Store restart, with exact retained identities and queue/Turn observations. Distinguish that proof from real host execution and Goal behavior.

## Execution Rules And Evidence

Use pinned Node 24.18.0 and pnpm 10.33.3, TMPDIR /home/simonx/.cache/openkit-tmp/L-GO-calendar/, CARGO_BUILD_JOBS=1, shared run-slot.sh for CPU-heavy work, one Vitest worker, no coverage/watch and explicit Turbo environment passthrough when needed. Tests remove their temporary roots. Commit at least hourly on this branch with configured identity and no attribution; the primary merges the branch without cherry-pick. Checks and remaining gaps will be recorded here as observed evidence, not acceptance claims.


## Checkpoint 1

The monthly creation regression failed at its intended assertion before production changes: the fixed-only schema rejected a valid explicit day-28 UTC rule. Frozen installation passed in 17.5 seconds; the strict package prerequisite build passed eight tasks in 25.256 seconds. After the schema and pure arithmetic change, automation/projection suites passed 11 tests and the cadence suite passed five tests. Focused Biome passed after formatting. Retained-range and first Store-materialization regressions are queued and have no result yet.

The primary granted the one-line automation operation safeExtend consequence and the feature-scoped lib/schema guide notes. The primary handed over AutomationStore and tests after its Audit correction; git merge fast-forwarded this branch to 2c755f9988baebf57f62a3dfb86782482d9c4b19 while preserving this helper's pending changes. Primary retains service/publication ownership and is adding single-scanner and once-only publication regressions; do not edit those files. The agreed Store ordering seam is a deterministic scalar registered idempotently per actual Core connection, receiving only cadence/cursor values and calling the same pure arithmetic before SQL LIMIT. It adds no persistent owner or public API. The portability helper received the monthlyUtc shape and shared validator names directly under primary authorization.
