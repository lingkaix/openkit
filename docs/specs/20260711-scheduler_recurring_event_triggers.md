---
status: Accepted
implementation: Not Started
updated: 2026-09-09
---
# Scheduler Recurring Triggers

## Owns

- Durable fixed-interval schedule definitions and occurrence history for requesting the existing worker Turn admission operation.
- The one NanoCore-local five-second scan, bounded admission retry, ten-minute expiry, restart, overlap, clock, and missed-occurrence rules for those schedules.
- The boundary between occurrence admission history and the existing scheduler, Turn, worker-runtime, permission, audit, storage, backup, and product-surface owners.

## Does Not Own

- Scheduler queue ordering, placement, leases, dispatch, Turn execution, worker-effect recovery, or Task and Goal workflow progression.
- A second executor, event bus, cron parser, calendar system, general workflow engine, generic job registry, or recovery coordinator.
- Domain events, webhooks, arbitrary operations, schedule dependencies, approval decisions, or actor substitution.
- Physical table DDL, retention-class vocabulary, AuditEvent schema, backup archive layout, portable import activation, or Web presentation.

## Core References

- `docs/core/foundation.md`
- `docs/core/identity.md`
- `docs/core/runtime-model.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`

## Summary

NanoCore may retain a fixed-interval instruction to request an ordinary worker Turn in one existing Thread. One serialized, process-local soft timer scans durable due work every five seconds. A schedule occurrence owns only whether NanoCore submitted that request into the existing durable scheduler admission queue; the scheduler and Turn owners continue to own whether and how it executes.

Each occurrence receives at most three committed admission-attempt outcomes: the initial attempt and two retries on later scans. A failed attempt is never retried in the same scan. If the third committed attempt fails, the occurrence becomes terminal `admission-failed`. If an unresolved occurrence reaches its deadline, exactly ten minutes after its original scheduled instant, it becomes terminal `expired` before another attempt. A transaction execution proved to have rolled back before any queue or launch effect is not an admission outcome and may run again on a later scan until that deadline. Once the existing scheduler queue row commits, the occurrence becomes terminal `admission-accepted` and recurring logic never resubmits it because dispatch or execution later defers, denies, fails, is interrupted, becomes unknown, or waits for approval.

## Goals / Non-goals

### Goals

- Preserve schedule definitions and every occurrence outcome across NanoCore restart.
- Recheck the exact responsible actor's current authority on every admission attempt.
- Keep retries within Core-local pre-admission effects and never replay an unknown external effect.
- Distinguish admission failure, accepted but not yet executed work, and later execution outcomes.
- Retain bounded, inspectable missed-occurrence history without an unbounded restart replay.

### Non-goals

- Do not support cron expressions, time zones, calendar rules, one-shot schedules, or domain-event subscriptions.
- Do not retry execution, answer an approval, replace a removed actor, or infer success from runtime activity.
- Do not create occurrence-owned run states that duplicate scheduler admission or Turn status.
- Do not promise high availability, multi-process scanning, or distributed timer ownership.

## Decision

### Supported operation and cadence

The first recurring operation is one direct worker Turn admission using the same durable scheduler primitive already used by Task and Goal worker execution. A definition retains one Workspace, one existing Thread, one worker input, optional requested Agent/profile/model selections, and the concrete `AutomationIdentity` for this schedule. Its `ActorRef` is `{ kind: 'automation', id: scheduleId, responsibleUserId: creatorUserId }`. It does not invoke the higher-level Task or Goal coordinator, create a new Thread, or generalize arbitrary Core operations.

The target Thread remains single-flight. At most one `admission-accepted` occurrence for a schedule may still link to a scheduler row whose current status is `queued`; one earlier occurrence may already be admitted or running. Distinct schedules targeting the same Thread may each have one queued occurrence, while scheduler admission and leases still prevent two Turns in that Thread from executing concurrently. This bounded waiting rule is the only trigger-specific overlap behavior; there is no skip policy or parallel execution mode.

The public cadence is `intervalSeconds`, an integer of at least five, plus the next exact UTC `scheduledAt` instant supplied on resume. Cron text is not accepted in this fixed-interval slice. Absolute UTC instants make recurrence independent of local time zones and daylight-saving changes. The five-second soft scanner grants no exact due-time precision guarantee.

Creating a schedule creates it `paused`. Resuming requires a `scheduledAt` that is not earlier than the current Core clock and sets the first due instant. The next nominal instant is always `scheduledAt + intervalSeconds`; scan delay never shifts the cadence.

### Durable definition

One `RecurringSchedule` record is the unique definition authority. Its minimum areas are:

- schedule ID, Workspace ID, target Thread ID, name, and status `paused`, `active`, or `deleted`;
- concrete Workspace-scoped `AutomationIdentity`, its exact automation `ActorRef`, and immutable responsible-user identity;
- interval seconds, worker input, and optional requested Agent/profile/model selections;
- next nominal scheduled instant, greatest nominal instant ever accounted for, revision, creation time, update time, and deletion time.

This specification is the separate owner for the schedule's bounded `AutomationIdentity` responsible-user binding; it adds no AutomationIdentity token, membership, or general automation authority. The schedule record is the concrete durable identity owner for this slice, so no synthetic actor summary exists without it. Trigger permissions are not stored grants: each attempt derives them from current Policy, and last-trigger time is a read projection over durable occurrence history rather than another mutable identity field. `active` permits due attempts, `paused` disables triggering while preserving identity and history, and `deleted` is its terminal revoked tombstone. The actor and responsible user cannot be edited or inferred. A different responsible actor requires a new schedule. Editing the cadence, target, or worker input is allowed only while paused and affects future occurrences only. Resume sets a future-or-current next instant strictly later than the greatest nominal instant ever accounted for, so pause, resume, or a backward clock jump cannot reuse an occurrence identity. The intentionally paused interval is not missed work. Delete stops future materialization and retains the identity tombstone and occurrence links; it does not cancel an accepted scheduler admission or rewrite its Turn.

Pause and delete first account for every nominal instant through their mutation time using the old immutable definition snapshot: unresolved instants still inside their deadline become individual `cancelled` occurrences and older instants become one or more lossless expired ranges. They also mark every existing `pending` occurrence `cancelled`. Edit runs only after pause has sealed that prior cadence. None of these mutations changes `admission-accepted`, `admission-failed`, or `expired` history. A compare-and-set definition revision prevents a scan from admitting work concurrently with a winning pause, edit, or delete.

### Durable occurrence

One `RecurringOccurrence` record represents exactly one nominal scheduled instant. Its deterministic identity derives from `(scheduleId, scheduledAt)`. Its minimum areas are:

- occurrence ID, schedule ID, Workspace ID, exact scheduled instant, and ten-minute deadline;
- immutable snapshot of the target Thread, exact automation `ActorRef`, authored worker input, authored optional Agent/profile/model selections, and nullable exact resolved admission payload containing Agent/profile/model selections, Workspace roots, and Workspace working directory;
- state `pending`, `admission-accepted`, `admission-failed`, `expired`, `cancelled`, or `recovery_required`;
- bounded admission-attempt summaries, each containing attempt number, attempt time, typed result code, and redacted summary;
- deterministic scheduler request ID and nullable scheduler queue-entry and Turn IDs;
- created time and terminal time.

The bounded attempt summaries contain at most three committed entries and are the authoritative trigger history. Authentication, authorization, lineage, bounded pre-admission preparation, input validation, selection resolution, and scheduler admission failures consume one attempt when the failed-attempt update commits. If optional selections cannot resolve, the occurrence retains its authored inputs and records the failed attempt. The first successful resolution freezes the exact Agent/profile/model selection, Workspace roots, and Workspace working directory in the same transaction as that attempt result or admission acceptance; later attempts validate and reuse that complete payload without substitution. A proved Core database rollback with no queue or launch effect leaves the attempt uncounted and permits a later scan before the deadline because it produced no admission outcome. An unknown commit result blocks another attempt until durable inspection proves the atomic acceptance tuple, a retryable pending record, or a contradiction. `recovery_required` is a terminal fence for contradictory durable identity or payload, is never scanner-eligible, and requires inspection rather than automatic repair. Scheduler queue status and Turn status remain with their existing owners and are joined by the stored queue-entry and Turn IDs for read models. An occurrence therefore projects accepted-but-not-executed truth as `state=admission-accepted` plus the linked scheduler status, rather than claiming a worker run succeeded.

Nominal instants already past their deadline before materialization use one lossless `ExpiredOccurrenceRange` instead of one physical row per instant. Its minimum areas are schedule ID, Workspace ID, definition revision, immutable interval seconds, first and last nominal scheduled instants, exact occurrence count, reason, creation time, terminal time, and the exact old-definition snapshot: target Thread, automation `ActorRef`, authored worker input, and requested Agent/profile/model selections. Those fields preserve what every covered task would have requested and identify each deterministic `(scheduleId, scheduledAt)` occurrence without separate physical rows. Ranges for different definition revisions never merge. History pagination returns ranges directly; an optional bounded time-window projection may enumerate covered occurrence identities, but no read expands an unbounded range.

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

No external runtime, provider, repository, or sandbox effect belongs to this transaction. Once the queue commit succeeds, every later unknown effect follows the existing scheduler, Turn, and worker-runtime contracts and is never replayed by the recurring scanner.

### Restart, clock changes, and missed history

Schedule and occurrence truth survives restart. After boot recovery, the ordinary scan resumes from durable definition cursors and pending occurrences; it does not shift deadlines by downtime duration. The ten-minute deadline always derives from the original nominal scheduled instant.

A forward wall-clock jump makes nominal instants due or expired under the same comparisons. A backward jump does not undo terminal history, reduce an attempt count, or create an earlier duplicate; no occurrence is due until the clock again reaches its nominal instant. Schedule calculations use integer interval arithmetic from the last nominal instant, not elapsed callback counts.

For each definition, the same transaction that inserts individual due occurrences or one exact expired range advances `nextScheduledAt` and `greatestAccountedScheduledAt` across precisely those nominal instants. A rollback advances neither. After an unknown database commit result, restart reads the deterministic occurrence or exact range coverage and advances only from durable truth; it never guesses that a missing instant was recorded.

The scan prioritizes unresolved occurrences and unmaterialized due instants whose deadlines have not passed. It processes at most 128 live admission candidates per scan in earliest-deadline order. It then persists expired ranges within the same fixed bound, ordered globally by earliest nominal instant through the ordinary due index. This preserves every missed scheduled instant without attempting expired work, blocking current eligible work behind an arbitrarily long outage, keeping a second history frontier, or performing unbounded writes in one scan. Work beyond the bounded scanner may expire; the scanner does not widen deadlines or claim queue capacity.

## Current Implementation Projection

`apps/nanocore/src/lib/automation-store.ts` currently holds user-owned cron-shaped definitions in a process-local `Map`; creation always pauses them, and no executor or persistence exists. That store and its routes do not implement this contract and must be replaced rather than extended as a second owner.

`apps/nanocore/src/runtime/product-turn-start.ts` currently rechecks the exact `triggerActor` with `runtime.launch`, derives deterministic queue and Turn identities from a request ID, creates the admission, and immediately invokes dispatch. `apps/nanocore/src/scheduler-records.ts` stores admissions in `core.sqlite`, but its current create seam is not request-idempotent and does not yet accept the occurrence transaction. Implementation must extract or reuse narrow preparation and shared-transaction seams, then leave dispatch to the normal service, instead of wrapping the combined start path or adding a second ledger.

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
- exact replay of an occurrence's own queued row reconciles before the backlog guard; one schedule never has more than one accepted occurrence still `queued`, `queue_backlog_full` consumes an ordinary failed attempt without creating a queue row, admitted/running/terminal work does not consume that waiting slot, and multiple accepted occurrences for one Thread execute only through the existing single-flight scheduler boundary;
- restart preserves pending attempt count and the original deadline, resumes on later scans, and never treats downtime as a new ten-minute window;
- backward and forward clock changes follow the defined nominal-instant rules without duplicate occurrence IDs;
- due materialization and schedule-cursor advancement commit atomically, exact expired ranges cover every older nominal instant without expansion, live work remains prioritized, and both scan phases respect the fixed bound;
- data-root backup and restore preserve active definitions, pending attempts, accepted links, terminal history, exact expired ranges, and schedule cursors, while portable import preserves only inert history.

The implementation should add the smallest deterministic timer/clock-injected unit checks plus the existing scheduler and storage integration checks. It must not add a second acceptance harness or real worker run to prove Core-local occurrence admission.

## Consequences

The fixed-interval input is less expressive than cron and intentionally avoids parser, time-zone, and calendar semantics. Durable attempted-occurrence history remains under `workspace-audit` retention with no automatic pruning in this slice; exact expired ranges and bounded per-scan work prevent a long outage from turning one callback into an unbounded write or execution burst.

Sustained overlap may record `queue_backlog_full` on three successive soft scans and close an occurrence `admission-failed` even if the waiting slot opens later within the ten-minute window. That terminal result does not reopen; it is a direct consequence of the selected three-attempt policy.

The shared SQLite transaction is a deliberate physical placement constraint. It closes the only safe automatic retry boundary without pretending Core can transact with worker effects.

## Open Questions

There are no unresolved product decisions in the initial fixed-interval slice. The engineer-selected timing, retry and admission boundary and the independently reviewed owner extensions are accepted; production implementation and runtime evidence remain outstanding.

## Deferred / Future Work

Cron and calendar schedules, one-shot schedules, event subscriptions, arbitrary operation families, schedule dependencies, configurable overlap policy, catch-up coalescing, user-configurable retry counts or deadlines, multi-process timer ownership, and distributed takeover remain outside this contract.

## Links

- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260703-runtime_scheduling_scale.md`
- `docs/specs/20260715-multi_user_workspace_system.md`
- `docs/specs/20260629-openkit_policy_model.md`
- `docs/specs/20260529-test_strategy.md`
