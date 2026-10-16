---
type: change-plan
status: in-progress
date: 2026-10-16
---
# Durable Recurrence

## Intent Revisions

1. The engineer assigned L-GO P21 on 2026-10-16: implement durable fixed-interval recurrence with single-flight admission, restart, pause, resume, cancellation and truthful failure. Land owner criteria, regression tests, generated interfaces, Web screens and operator instructions together. Keep calendar triggers independent of Goal wake under recommended decision #194. Prove local behavior only; L-OPS retains real host acceptance.

## Authority

The accepted [Recurring Triggers](../../specs/20260711-scheduler_recurring_event_triggers.md) owner defines the cadence, exact occurrence, bounded attempt lifecycle and atomic Core queue acceptance. [Storage Layout](../../specs/20260703-storage_layout_record_ownership.md) owns physical homing. Existing scheduler, Workspace mutation, Audit, deletion and portability owners retain their responsibilities. This feature creates no second executor or automatic external-effect retry.

## Working Checkpoint

The helper delivered durable definitions, occurrences, expired ranges, native operations and the serialized scanner in dba79e35, ad6b4ee3 and a1165ea4. Its checks passed 22 store tests, 10 scanner tests, 122 schema tests and seven operation/client tests. The primary merged those commits. The native Drizzle journal now creates all three tables; the helper fixture-only schema initializer is removed. The app uses the exact same Core connection and Workspace mutation gate as the scanner. Bounded preparation reuses the current Agent selection, setup and Workspace-root owners and has no runtime or Provider invocation port. Startup begins scanning after critical recovery; shutdown stops it before listener closeout.

Fresh direction check: the independent helper inspected the actual integration sources after primary context recovery. The route follows the accepted owner. It identified required exact scheduler publication and Thread exclusion, preservation of queue-only acceptance across boot, stop-before-shutdown, Core-homed closure/retention, inert portable import and P14 identity alignment. These remain integration acceptance obligations, not deferred work.

The first native migration probe failed because the custom SQL lacked Drizzle statement boundaries; this was setup failure, not product regression. After correction, the new scheduler regression reproduced accepted queue rows that could not publish a Turn. The Audit regression reproduced omitted Core-homed Workspace events. Both joins are corrected and await verification. Two preparation regressions passed with the real setup resolver, proving exact selection and refusal to substitute frozen selections without queue or Turn effects.

The first publisher assumption was rejected by independent owner review: the scheduler no-repair rule does not authorize reconstruction from an accepted tuple. After Consultant scrutiny, the coordinator selected the current-owner inspection route in [the recorded decision](../../decisions/20261016-recurring_publication_inspection.md). The unconditional publisher and empty update retry are removed. Source admission makes one fenced initial publication attempt; history projects missing or contradictory actual Turns as recovery_required, and existing queue cancel releases the waiting slot. No durable publication field or repair runner is accepted. Earlier three green reconstruction tests prove the discarded assumption only and are not acceptance evidence for the selected route.

Next action: verify the corrected no-repair scheduler and Audit corrections with native migrations alone, complete closure and inert portability, add Web lifecycle/history and manuals, then align identifiers when P14 lands. Review and full CI follow generated interfaces and applicable checks. Calendar admission follows this fixed-interval feature; it cannot reuse Goal wake authority.

## Verification And Closeout

This is an incomplete integration snapshot. No landing or end-to-end acceptance is claimed. The scheduler tests model only the backend port; they do not prove real Worker execution or host acceptance. Final evidence must include native migration, restart/publication failure, exact queue identity, current actor authority, lifecycle/history, inert import and product controls.
