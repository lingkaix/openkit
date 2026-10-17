---
status: Accepted
implementation: Partial
kind: concept
updated: 2026-10-17
---
# Scheduler Recurring Triggers

## Owns

- Durable fixed-interval and bounded monthly UTC schedule definitions and occurrence history for requesting the existing worker Turn admission operation.
- The closed daily Knowledge Manager maintenance trigger below, through the same scan and existing work records.
- The one NanoCore-local five-second scan, bounded admission retry, ten-minute expiry, restart, overlap, clock, and missed-occurrence rules for those schedules.
- The boundary between occurrence admission history and the existing scheduler, Turn, worker-runtime, permission, audit, storage, backup, and product-surface owners.

## Does Not Own

- Scheduler queue ordering, placement, execution attempts, dispatch, Turn execution, worker-effect recovery, or Task and Goal workflow progression.
- A second executor, event bus, cron parser, general calendar system, general workflow engine, generic job registry, or recovery coordinator.
- Domain events, webhooks, arbitrary operations, schedule dependencies, approval decisions, or actor substitution.
- Physical table DDL, retention-class vocabulary, AuditEvent schema, backup archive layout, portable import activation, or Web presentation.

## Core References

- `docs/core/foundation.md`
- `docs/core/identity.md`
- `docs/core/runtime-model.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`

## Summary

NanoCore may retain a fixed-interval or bounded monthly UTC instruction to request an ordinary worker Turn in one existing Thread. One serialized, process-local soft timer scans durable due work every five seconds. A schedule occurrence owns only whether NanoCore submitted that request into the existing durable scheduler admission queue; the scheduler and Turn owners continue to own whether and how it executes.

Each occurrence receives at most three committed admission-attempt outcomes: the initial attempt and two retries on later scans. A failed attempt is never retried in the same scan. If the third committed attempt fails, the occurrence becomes terminal `admission-failed`. If an unresolved occurrence reaches its deadline, exactly ten minutes after its original scheduled instant, it becomes terminal `expired` before another attempt. A transaction execution proved to have rolled back before any queue or launch effect is not an admission outcome and may run again on a later scan until that deadline. Once the existing scheduler queue row commits, the occurrence becomes terminal `admission-accepted` and recurring logic never resubmits it because dispatch or execution later defers, denies, fails, is interrupted, becomes unknown, or waits for approval.

## Goals / Non-goals

### Goals

- Preserve schedule definitions and every occurrence outcome across NanoCore restart.
- Recheck the exact responsible actor's current authority on every admission attempt.
- Keep retries within Core-local pre-admission effects and never replay an unknown external effect.
- Distinguish admission failure, accepted but not yet executed work, and later execution outcomes.
- Retain bounded, inspectable missed-occurrence history without an unbounded restart replay.

### Non-goals

- Do not support cron expressions, zones other than literal UTC, calendar rules outside the monthly UTC variant below, one-shot schedules, or domain-event subscriptions.
- Do not retry execution, answer an approval, replace a removed actor, or infer success from runtime activity.
- Do not create occurrence-owned run states that duplicate scheduler admission or Turn status.
- Do not promise high availability, multi-process scanning, or distributed timer ownership.

## Decision

### Supported operation and cadence

The first recurring operation is one direct worker Turn admission using the same durable scheduler primitive already used by Task and Goal worker execution. A definition retains one Workspace, one existing Thread, one worker input, optional requested Agent/profile/model selections, and the concrete `AutomationIdentity` for this schedule. Its `ActorRef` is `{ kind: 'automation', id: scheduleId, responsibleUserId: creatorUserId }`. It does not invoke the higher-level Task or Goal coordinator, create a new Thread, or generalize arbitrary Core operations.

The target Thread remains single-flight. At most one `admission-accepted` occurrence for a schedule may still link to a scheduler row whose current status is `queued`; one earlier occurrence may already be admitted or running. Distinct schedules targeting the same Thread may each have one queued occurrence, while scheduler admission and execution-attempt exclusion still prevent two Turns in that Thread from executing concurrently. This bounded waiting rule is the only trigger-specific overlap behavior; there is no skip policy or parallel execution mode.

The fixed-interval public cadence is `intervalSeconds`, an integer of at least five, plus the next exact UTC `scheduledAt` instant supplied on resume. Cron text is not accepted in this fixed-interval slice. Absolute UTC instants make recurrence independent of local time zones and daylight-saving changes. The five-second soft scanner grants no exact due-time precision guarantee.

Creating a schedule creates it `paused`. Resuming requires a `scheduledAt` that is not earlier than the current Core clock and sets the first due instant. For a fixed interval, the next nominal instant is always `scheduledAt + intervalSeconds`; scan delay never shifts the cadence.

### Monthly UTC cadence

Monthly UTC is the second closed timing variant of the same RecurringSchedule and direct Worker admission. Its complete authored timing value is `monthlyUtc: { zone: 'UTC', dayOfMonth, hour, minute, second }`. `dayOfMonth` is an integer from 1 through 28, `hour` from 0 through 23, and `minute` and `second` from 0 through 59. Milliseconds are zero. Exactly one of `intervalSeconds` and `monthlyUtc` is present. Existing fixed-interval shapes and retained bytes remain usable without a migration, compatibility layer, dual write or artificial interval. Readers must understand the admitted timing core; an unknown variant, non-UTC zone, contradictory shapes, unsupported required semantics or invalid value fails closed. Descriptive additions retain the ordinary extension rules.

Each calendar month has exactly one nominal instant with that Gregorian UTC day and time. The successor uses the following nominal calendar month, never a fixed elapsed duration, callback, attempt, acceptance or completion time. Resume supplies a current-or-future exact UTC instant matching the complete rule, with zero milliseconds and strictly after the greatest nominal instant already accounted for. A mismatch conflicts without changing the definition; Core must not normalize it to another date. Calendar or timestamp overflow is a refusal, not wraparound. Days 29 through 31, last-day rules, ordinal weekdays, local or browser time, numeric offset zones, IANA zones, DST conversion, holidays, cron and RRULE are excluded.

Creation is paused. A paused edit supplies either complete timing shape and atomically replaces the previous shape; supplying both is invalid. Pause and delete seal the old rule and revision through their mutation time before future edits. Monthly occurrence snapshots retain the old monthly rule; exact expired ranges retain that same rule, revision and immutable request snapshot. An intentionally paused interval is not missed work. Accepted work and its original snapshot are never changed by pause, edit or delete. The existing queued-admission cancellation owner may release the waiting slot without reopening an occurrence or changing future month boundaries.

A missed monthly prefix is located directly by integer Gregorian month indices. Its count is the inclusive month-index difference between its exact first and last matching instants; elapsed duration divided by an assumed month length is invalid. Range readers validate rule matching, order, exact count and snapshot consistency. They do not enumerate an unbounded outage. Candidate selection, including native SQL ordering before its limit, compares the actual first live nominal instant for both variants. One shared scan retains the aggregate bound of 128 live candidates, live-before-expired priority, and bounded range accounting; the bound is not multiplied per cadence. Cursor and greatest-accounted advancement remain in the same transaction as the exact occurrence or range coverage.

All existing responsible-user, automation actor, membership, policy, Thread audience, mutation-fence, Audit, ten-minute deadline, three-outcome attempt, frozen selection, one waiting-slot, restart, forward/backward clock, atomic queue acceptance and unknown-result rules apply unchanged. The scanner admits existing Worker work; it submits no Worker and starts no new timer, runner, API family or record family. Once-only initial Turn publication and later missing or contradictory publication keep the existing no-repair contract. Portable monthly definitions and history are descriptive and inert under the existing transfer owner. Import restores no live schedule, cursor, queue or admission authority and creates no absent Turn. Retained canonical historical Turns still import and remap under [Workspace Backup, Export And Import](20260704-workspace_backup_export_import.md).

Acceptance includes January 28, February 28 and March 28 at one explicit UTC time through the existing native admission service over the same retained definition and Thread, with a Core/Store reopen before February and no duplicate after repeat scans or another reopen. Exact history must show the three distinct accepted instants, immutable responsible actor and request, actual queue states and real Turn links where publication exists. January-to-February and February-to-March have different elapsed lengths. Lower-level checks cover leap years, year boundaries, invalid days and zones, resume mismatch, overflow, old-revision sealing, long-outage range counts, SQL live-frontier ordering and the inherited failure rules. This proves local monthly admission, not real host execution or completion.

Recurring Goal creation remains an open follow-up only. This variant creates no Goal or Coordinator Turn, carries no Plan approval, changes no Goal wake marker, and grants no Goal progression or completion authority. The accepted ruling is [Bounded Monthly UTC Recurring Work](../decisions/20261017-monthly_utc_recurring_work.md).

### Knowledge Manager daily maintenance

The same recurring scan also triggers one closed internal operation: a bounded Knowledge Manager maintenance Turn for one Server, User or Workspace notebook scope. It is not an arbitrary operation target or Worker dispatch. Each scope has one independent on/off setting, default off. The cadence is fixed daily; explicit run requests remain available through the Knowledge Manager owner. There are no additional schedule knobs, a second timer, a new scheduler or a new occurrence family. Existing Worker schedule definitions and their admission rules remain unchanged.

The [Knowledge Manager owner](20260704-knowledge_manager_internal_agent_runtime.md#query-and-maintenance-execution) owns fresh input assembly, single-writer admission, instructions and fixed-base publication. Existing scope configuration and maintenance Thread, Turn and Item records retain enablement, due-run lineage and visible outcomes; no Worker identity or Workspace membership is fabricated for User or Server scopes. The trigger checks current scope authority and delegation. Failed or skipped scheduled work records a visible outcome and reason through the existing work owners. It never authorizes publication, automatically retries a model run or silently claims that a source range was processed.

### Durable definition

One `RecurringSchedule` record is the unique definition authority. Its minimum areas are:

- schedule ID, Workspace ID, target Thread ID, name, and status `paused`, `active`, or `deleted`;
- concrete Workspace-scoped `AutomationIdentity`, its exact automation `ActorRef`, and immutable responsible-user identity;
- exactly one complete timing shape, worker input, and optional requested Agent/profile/model selections;
- next nominal scheduled instant, greatest nominal instant ever accounted for, revision, creation time, update time, and deletion time.

This specification is the separate owner for the schedule's bounded `AutomationIdentity` responsible-user binding; it adds no AutomationIdentity token, membership, or general automation authority. The schedule record is the concrete durable identity owner for this slice, so no synthetic actor summary exists without it. Trigger permissions are not stored grants: each attempt derives them from current Policy, and last-trigger time is a read projection over durable occurrence history rather than another mutable identity field. `active` permits due attempts, `paused` disables triggering while preserving identity and history, and `deleted` is its terminal revoked tombstone. The actor and responsible user cannot be edited or inferred. A different responsible actor requires a new schedule. Editing the cadence, target, or worker input is allowed only while paused and affects future occurrences only. Resume sets a future-or-current next instant strictly later than the greatest nominal instant ever accounted for, so pause, resume, or a backward clock jump cannot reuse an occurrence identity. The intentionally paused interval is not missed work. Deleted definitions remain discoverable as read-only history and cannot resume. Delete stops future materialization and retains the identity tombstone and occurrence links; it does not cancel an accepted scheduler admission or rewrite its Turn.

Pause and delete first account for every nominal instant through their mutation time using the old immutable definition snapshot: unresolved instants still inside their deadline become individual `cancelled` occurrences and older instants become one or more lossless expired ranges. They also mark every existing `pending` occurrence `cancelled`. Edit runs only after pause has sealed that prior cadence. None of these mutations changes `admission-accepted`, `admission-failed`, or `expired` history. A compare-and-set definition revision prevents a scan from admitting work concurrently with a winning pause, edit, or delete.

### Durable occurrence

One `RecurringOccurrence` record represents exactly one nominal scheduled instant. Its deterministic identity derives from `(scheduleId, scheduledAt)`. Its minimum areas are:

- occurrence ID, schedule ID, Workspace ID, exact scheduled instant, and ten-minute deadline;
- immutable snapshot of the target Thread, exact automation `ActorRef`, authored worker input, authored optional Agent/profile/model selections, monthly UTC rule when present, and nullable exact resolved admission payload containing Agent/profile/model selections, Workspace roots, and Workspace working directory;
- state `pending`, `admission-accepted`, `admission-failed`, `expired`, `cancelled`, or `recovery_required`;
- bounded admission-attempt summaries, each containing attempt number, attempt time, typed result code, and redacted summary;
- deterministic scheduler request ID and nullable scheduler queue-entry and Turn IDs;
- created time and terminal time.

The bounded attempt summaries contain at most three committed entries and are the authoritative trigger history. Authentication, authorization, lineage, bounded pre-admission preparation, input validation, selection resolution, and scheduler admission failures consume one attempt when the failed-attempt update commits. If optional selections cannot resolve, the occurrence retains its authored inputs and records the failed attempt. The first successful resolution freezes the exact Agent/profile/model selection, Workspace roots, and Workspace working directory in the same transaction as that attempt result or admission acceptance; later attempts validate and reuse that complete payload without substitution. A proved Core database rollback with no queue or launch effect leaves the attempt uncounted and permits a later scan before the deadline because it produced no admission outcome. An unknown commit result blocks another attempt until durable inspection proves the atomic acceptance tuple, a retryable pending record, or a contradiction. `recovery_required` is a terminal fence for contradictory durable identity or payload, is never scanner-eligible, and requires inspection rather than automatic repair. Scheduler queue status and Turn status remain with their existing owners and are joined by the stored queue-entry and Turn IDs for read models. An occurrence therefore projects accepted-but-not-executed truth as `state=admission-accepted` plus the linked scheduler status, rather than claiming a worker run succeeded.

Nominal instants already past their deadline before materialization use one lossless `ExpiredOccurrenceRange` instead of one physical row per instant. Its minimum areas are schedule ID, Workspace ID, definition revision, immutable timing shape, first and last nominal scheduled instants, exact occurrence count, reason, creation time, terminal time, and the exact old-definition snapshot: target Thread, automation `ActorRef`, authored worker input, and requested Agent/profile/model selections. Those fields preserve what every covered task would have requested and identify each deterministic `(scheduleId, scheduledAt)` occurrence without separate physical rows. Ranges for different definition revisions never merge. History pagination returns ranges directly; an optional bounded time-window projection may enumerate covered occurrence identities, but no read expands an unbounded range.

### Identifier producers

The native definition producer allocates a new schedule through shared `allocateEntityId('auto')`. It retains that identity through pause, edit, resume, delete tombstone and reopen. A new native occurrence uses kind `occ` and the shared UUIDv5 derivation over the exact UTF-8 JSON array `[scheduleId, scheduledAt]`; `scheduledAt` is the canonical recorded UTC millisecond timestamp. The same nominal pair always names the same occurrence. A new retained expired range uses kind `range` and shared UUIDv7 allocation at its first insertion. Its allocated identity is retained on replay and reopen; range identity is not a second derivation of its covered instants. The fixed source Turn uses existing kind `tu` and shared UUIDv5 derivation over the exact UTF-8 JSON array `["recurring", scheduleId, scheduledAt]`. These declarations use the shared entity allocation and derivation APIs, kind namespaces and canonical name encoding in [Core Protocol](../core/protocol.md#ids), under [Identifier Owner Declarations](../decisions/20261015-identifier_owner_declarations.md) and [Identifier Derivation And Import Allocations](../decisions/20261016-identifier_derivation_and_import_allocations.md). They permit no private formatter, validator exception, alternate identifier owner or new record family.

Portable import remints each schedule with shared `allocateEntityId('auto')`, derives its imported occurrence identities from that reminted schedule and the same canonical UTC timestamp, and allocates imported range identities only within the invocation-local accepted import map. It restores no live Core schedule, cursor, queue or admission authority and creates no absent Turn; retained canonical historical Turns still remap under the existing Workspace import owner. The source admission, exact queue replay, accepted-occurrence terminality and no-repair rules are unchanged. Shared registry admission and implementation cutover follow the identifier owner; this producer declaration does not authorize mixing an unlanded identifier implementation into a delivery branch.

### Scan and retry lifecycle

NanoCore starts exactly one serialized recurring scan after critical storage and scheduler boot recovery complete. The timer is soft: it requests a scan every five seconds, but a scan never overlaps the preceding scan and missed timer callbacks are not replayed. Each scan reads a Core-owned UTC wall-clock instant to select candidates. It reads the clock again immediately before each admission transaction so slow preparation cannot commit a new queue row at or after that occurrence's deadline.

For each selected unresolved occurrence:

1. If selection time is at or after `scheduledAt + 10 minutes`, commit `expired` without an admission attempt.
2. Otherwise re-resolve the stored Workspace, Thread, concrete active `AutomationIdentity`, responsible user, current active Workspace membership, current policy, `turn.run`, and `runtime.launch` authority. Resolve any still-null exact admission payload as an in-memory candidate, including Agent/profile/model selections, Workspace roots, and Workspace working directory, then run only the existing bounded pre-admission setup whose Core-local effects are proved idempotent; an unknown effect fences the occurrence `recovery_required`.
3. Re-read the clock immediately before the Core transaction. If it is earlier than `scheduledAt`, leave the occurrence pending without recording an attempt. If it is at or after the deadline, commit `expired` and create no queue row. Only the remaining interval from `scheduledAt` inclusive to the deadline exclusive permits an attempt result or admission commit.
4. Within that interval and in the same Core transaction, first reconcile this occurrence's own deterministic queue identity. If no row exists for it, check whether another accepted occurrence of this schedule links to a currently `queued` scheduler row. If another does, commit typed failure `queue_backlog_full` and no queue row. Otherwise commit any first successful exact-payload resolution together with the resulting attempt record or acceptance, then attempt the existing scheduler admission once with the occurrence's deterministic request identity and immutable input snapshot or commit the typed failure already established by the current authority, selection, validation, or preparation checks. Never persist a resolved payload in a standalone prewrite.
5. If the scheduler queue row and matching occurrence acceptance commit, mark `admission-accepted` and never select the occurrence again.
6. If admission fails before that commit, append one typed attempt summary. Leave the occurrence `pending` after attempt one or two; attempt it again only on a later five-second scan. After attempt three, commit terminal `admission-failed`.

There are exactly three committed admission-attempt outcomes, not three retries. `admission-failed` is terminal and does not later become `expired`. `expired` applies only to an unresolved occurrence that has not exhausted its attempts. A scan at the exact deadline expires before attempting. A proved rollback with no queue or launch effect may cause another transaction execution before the deadline; it does not create a fourth committed outcome.

The active-member baseline follows the existing Workspace permission owner. Reads require the current `workspace.read` allow; create, edit, pause, resume, and delete require the current `workspace.configure` allow. Every due attempt requires the stored `AutomationIdentity` to remain active, its responsible user to remain active and an active member, and its exact automation actor to receive current `turn.run` and `runtime.launch` allows. Missing identity, membership, user, policy, Workspace, Thread, or scheduler, and stale Agent/config or invalid input, produces a typed failed attempt. No owner, administrator, another member, system actor, or different Agent may substitute for the stored actor or occurrence snapshot.

An approval required after admission remains an ordinary Turn approval. Recurring logic cannot approve it, bypass it, create another occurrence for it, or treat waiting for approval as admission failure.

### Core transaction and unknown effects

Definitions and occurrences are Workspace-attributed product records physically stored in `core.sqlite` because occurrence acceptance and `scheduler_admission_entries` must share one NanoCore SQLite transaction. The transaction inserts or proves the exact deterministic queue row, records its queue-entry and Turn identities on the occurrence, and changes that occurrence to `admission-accepted`. A rollback leaves neither acceptance nor a new queue row.

After exact replay reconciliation, that transaction also enforces the per-schedule queued-occurrence bound against current scheduler rows. Only another occurrence's `queued` row counts: a scheduler row already `admitted`, including one whose linked Turn is running, or one that is denied, cancelled, expired, or otherwise terminal does not block the one waiting slot. A full waiting slot records `queue_backlog_full` as an ordinary failed attempt under the same three-outcome and deadline rules; it creates no queue row, trigger state, or scheduler capacity claim.

The command must treat an existing deterministic queue row with the exact occurrence identity and immutable payload as the same accepted result whether that row is now queued, admitted, denied, cancelled, or expired. It reconciles the occurrence to `admission-accepted` without creating or reopening work. A conflicting row is `recovery_required` and must not be overwritten or retried. An implementation state in which a queue row may have committed but its occurrence still appears retryable is forbidden. If current implementation seams cannot provide the shared transaction, implementation must stop at design rather than introduce a cross-store retry or infer which write won.

The recurring service reuses only the existing bounded pre-admission setup and admission owners, then leaves the ordinary scheduler service to dispatch. Current Workspace-root setup may create missing local directories before admission; repeating that proved idempotent Core-local setup is allowed, while worker launch, provider calls, repository effects, and any unproved effect are not. The service must not call the current combined `startProductTurn` path as its producer because that path performs inline dispatch and may report `scheduler_admission_deferred` after the queue row committed.

The source admission attempts initial fixed pending Turn file publication once, while it still holds the existing Workspace mutation fence. A publication interruption never reopens acceptance or permits another publication attempt by a scan, restart or dispatch. The scheduler inspects the existing accepted tuple without creating or synchronizing Turn files. A missing or contradictory fixed Turn remains non-dispatchable `recovery_required`; public occurrence history exposes the cause and does not present the reserved identity as an existing Turn. The existing queue cancel operation can release that held series waiting slot without fabricating a missing Turn or changing contradictory history. Normal Thread single-flight remains in force: a damaged pending Turn can still hold its original Thread. Later occurrences use current authority and ordinary Thread admission; an authorized paused target edit can select another existing Thread. Cadence, committed attempt counts and history remain unchanged. An initial file error fails only that operation, preserves its files and leaves the Workspace writable; retry or restart uses canonical history. No Store-lifetime Workspace lock is permitted. Export uses canonical Turn and Item data rather than refusing a disagreement with the derivative cache. A missing or contradictory canonical accepted Turn still follows the existing inspection rule. No durable publication field, repair command or runner is introduced ([decision](../decisions/20261016-recurring_publication_inspection.md)).

No external runtime, provider, repository, or sandbox effect belongs to this transaction. Once the queue commit succeeds, every later unknown effect follows the existing scheduler, Turn, and worker-runtime contracts and is never replayed by the recurring scanner.

### Restart, clock changes, and missed history

Schedule and occurrence truth survives restart. After boot recovery, the ordinary scan resumes from durable definition cursors and pending occurrences; it does not shift deadlines by downtime duration. The ten-minute deadline always derives from the original nominal scheduled instant.

A forward wall-clock jump makes nominal instants due or expired under the same comparisons. A backward jump does not undo terminal history, reduce an attempt count, or create an earlier duplicate; no occurrence is due until the clock again reaches its nominal instant. Schedule calculations use the admitted interval or Gregorian UTC month arithmetic from the last nominal instant, not elapsed callback counts.

For each definition, the same transaction that inserts individual due occurrences or one exact expired range advances `nextScheduledAt` and `greatestAccountedScheduledAt` across precisely those nominal instants. A rollback advances neither. After an unknown database commit result, restart reads the deterministic occurrence or exact range coverage and advances only from durable truth; it never guesses that a missing instant was recorded.

The scan prioritizes unresolved occurrences and unmaterialized due instants whose deadlines have not passed. It processes at most 128 live admission candidates per scan in earliest-deadline order. It then persists expired ranges within the same fixed bound, ordered globally by earliest nominal instant through the ordinary due index. This preserves every missed scheduled instant without attempting expired work, blocking current eligible work behind an arbitrarily long outage, keeping a second history frontier, or performing unbounded writes in one scan. Work beyond the bounded scanner may expire; the scanner does not widen deadlines or claim queue capacity.

## Current Implementation Projection

The existing scan invokes the closed Knowledge Manager callback after finite Worker admission preparation. All scope settings parse a separate daily switch, default off. The Workspace callback retains a maintenance Turn before Provider work and deduplicates by the retained scheduled Turn's UTC day. Missing scope, notebook or model admission retains a visible failed outcome. The scan does not wait for model execution. User and Server execution joins remain pending; they have no substitute Workspace or fabricated identity.

`apps/nanocore/src/lib/automation-store.ts` replaces the process-local cron store with durable fixed-interval and monthly UTC definitions, immutable occurrences, and expired ranges. Its Core transaction joins the existing scheduler queue insertion to acceptance and its required AuditEvent. Definition changes and scanner writes share the existing Workspace mutation fence. Opaque request UUIDs use the existing UUIDv5 API with the fixed RFC 4122 URL namespace (`6ba7b811-9dad-11d1-80b4-00c04fd430c8`) and the UTF-8 JSON pair `[scheduleId, scheduledAt]`. The instant is normalized to UTC milliseconds before this derivation. The shared identifier producer declarations above are the accepted cutover target; their registry integration remains pending the identifier owner landing.

`apps/nanocore/src/runtime/recurring-schedule-service.ts` serializes five-second scans and checks the exact responsible actor before preparation and transaction commit. It accepts only bounded Core-local preparation and never invokes the worker executor or combined product Turn starter. The definition-derived automation family exposes the lifecycle and bounded occurrence/range history, including current scheduler status without backend or host paths.

Migration, boot composition, scheduler publication/recovery, Workspace audit aggregation, portable export/import, generated contracts, and product surfaces require integration before this feature is complete. Focused regressions cover the storage and scanner boundaries; they do not establish those integrated outcomes.

## Storage, audit, backup, and portability dependencies

The storage owner places Workspace-attributed definitions, occurrences, and expired ranges in `core.sqlite`, indexes due/deadline and Workspace history reads, and includes them in data-root backup and same-deployment restore. The records retain authored schedule input but no credentials, provider responses, runtime transcripts, or secret material. Definition tombstones, occurrence/range history, and their AuditEvents use the existing `workspace-audit` retention class. This slice adds no automatic pruning or maintenance runner; Workspace deletion, sealed closure, and legal hold continue through their existing owners.

Portable Workspace export includes definitions, immutable occurrence history, and linked scheduler/Turn references only as inert historical data. Import cannot activate a schedule, restore pending admission, synthesize scheduler rows or Turns, or treat source actors as target authority. Any future activation requires a newly created target schedule under current authority.

User create, edit, pause, resume, and delete mutations require the existing Workspace mutation fence so backup, export, and deletion cannot race a definition change. The scanner uses the same fence before materialization or admission. Occurrence attempt summaries are operational product history, not AuditEvents and not a second audit journal. Every definition mutation and every terminal occurrence or expired-range transition emits the existing Workspace-attributed `AuditEvent`; the mutation or transition and its AuditEvent commit in the same `core.sqlite` transaction, and audit persistence failure rolls back that local transition. One expired range emits one range AuditEvent carrying its exact bounds and count, not one event per deterministically covered instant. Workspace audit reads aggregate these Core-homed rows without a cross-database write or second journal.

## Testing Strategy / Acceptance Criteria

Acceptance requires deterministic tests proving:

- create is paused; authorized edit, resume, pause, and delete obey revision and mutation-fence rules, and actor identity cannot be changed;
- no admission happens before the nominal instant, including after a backward clock jump between selection and commit; a due occurrence attempts once per scan, attempt three closes `admission-failed`, and an unresolved occurrence at or after the original ten-minute deadline closes `expired` without another attempt;
- every attempt rechecks the exact active AutomationIdentity, responsible user, active membership, Workspace/Thread lineage, current policy, `turn.run`, and `runtime.launch`; a failed initial selection resolution remains recordable, the first successful Agent/profile/model and Workspace roots/working-directory resolution freezes atomically with its outcome for later retries, no standalone prewrite exists, and no substitute actor or approval bypass exists;
- at most three committed failure outcomes close `admission-failed`; a proved rollback with no queue or launch effect remains uncounted and may rerun only before the unchanged deadline, while an unknown commit result never retries before durable inspection;
- queue-row creation and `admission-accepted` commit atomically, exact deterministic replay returns the same accepted result, and a conflicting row closes the occurrence in terminal `recovery_required` without retry or restart selection;
- every definition mutation and terminal occurrence/range transition commits its required Workspace-attributed AuditEvent atomically, including one bounded AuditEvent for an expired range rather than per-instant expansion;
- accepted queued work is never resubmitted after later scheduler denial, dispatch delay, Turn failure, interruption, unknown effect, or approval wait;
- exact replay of an occurrence's own queued row reconciles before the backlog guard; one schedule never has more than one accepted occurrence still `queued`, including after an explicit scheduler retry of an older denied entry; that retry refuses while the series waiting slot is occupied and changes no occurrence attempt or history; `queue_backlog_full` consumes an ordinary failed attempt without creating a queue row, admitted/running/terminal work does not consume that waiting slot, and multiple accepted occurrences for one Thread execute only through the existing single-flight scheduler boundary;
- restart preserves pending attempt count and the original deadline, resumes on later scans, and never treats downtime as a new ten-minute window;
- backward and forward clock changes follow the defined nominal-instant rules without duplicate occurrence IDs;
- due materialization and schedule-cursor advancement commit atomically, exact expired ranges cover every older nominal instant without expansion, live work remains prioritized, and both scan phases respect the fixed bound;
- data-root backup and restore preserve active definitions, pending attempts, accepted links, terminal history, exact expired ranges, and schedule cursors, while portable import preserves only inert history.

The implementation should add the smallest deterministic timer/clock-injected unit checks plus the existing scheduler and storage integration checks. It must not add a second acceptance harness or real worker run to prove Core-local occurrence admission.

## Consequences

The two bounded cadence variants are less expressive than cron and intentionally avoid parser, non-UTC time-zone, and general calendar semantics. Durable attempted-occurrence history remains under `workspace-audit` retention with no automatic pruning in this slice; exact expired ranges and bounded per-scan work prevent a long outage from turning one callback into an unbounded write or execution burst.

Sustained overlap may record `queue_backlog_full` on three successive soft scans and close an occurrence `admission-failed` even if the waiting slot opens later within the ten-minute window. That terminal result does not reopen; it is a direct consequence of the selected three-attempt policy.

The shared SQLite transaction is a deliberate physical placement constraint. It closes the only safe automatic retry boundary without pretending Core can transact with worker effects.

## Open Questions

There are no unresolved product decisions in the admitted fixed-interval and monthly UTC Worker-admission slices. Recurring Goal creation remains open and is not specified here. The timing, retry and admission boundary recorded in [Schedule Admission Numbers Are Empirical Defaults](../decisions/20260924-schedule_admission_numbers_are_empirical.md) and the independently reviewed owner extensions are accepted; production implementation and runtime evidence remain outstanding.

## Deferred / Future Work

Cron and other calendar schedules, non-UTC zones, days 29 through 31 and last-day rules, recurring Goal creation, one-shot schedules, event subscriptions, arbitrary operation families, schedule dependencies, configurable overlap policy, catch-up coalescing, user-configurable retry counts or deadlines, multi-process timer ownership, and distributed takeover remain outside this contract.

## Links

- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260703-runtime_scheduling_scale.md`
- `docs/specs/20260715-multi_user_workspace_system.md`
- `docs/specs/20260629-openkit_policy_model.md`
- `docs/specs/20260529-test_strategy.md`
