# Scheduler Recurring And Event Triggers

Status: Draft
Implementation: Not Started

## Owns

- The durable schedule record contract: recurring and one-shot schedules, `next_fire_at` semantics, cadence expressions, and schedule lifecycle.
- The tick loop contract: a minute-granularity heartbeat that drains due schedules into admission queue entries.
- The fire record contract: write-ahead intent for every fire, with typed outcomes.
- Missed-fire catch-up policy (coalescing) across downtime and restart.
- Overlap policy when a schedule fires while its previous fire is still executing.
- The one-shot event-trigger convention: how domain events (redo, review rejection, negative feedback, suite failure) become trigger rows in the same mechanism.
- The replacement of the in-memory automation store with durable schedule records.

## Does Not Own

- Turn admission, queue ordering, placement, leases, or dispatch. `docs/specs/20260703-durable_scheduler_design.md` owns those; this spec only produces admission queue entries through its contract.
- Priority class definitions. The durable scheduler spec owns the closed class set; this spec only assigns classes to fires.
- What a triggered turn does. `docs/specs/20260710-self_improvement_evaluation_loop.md` owns reflection semantics; product automation semantics belong to their own product surfaces.
- The definitions of redo, refinement, steering, review, and Human Attention events. `docs/specs/20260531-human_attention_intervention_model.md` owns those.
- Metering enforcement and budget caps. `docs/core/metering.md` and future metering enforcement work own those; this spec only defines how fires behave when a budget signal exists.
- Storage layout policy. `docs/specs/20260703-storage_layout_record_ownership.md` owns the file-versus-SQLite policy; schedule records project into it.

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-workflow.md`
- `docs/core/metering.md`
- `docs/core/audit.md`

## Related Specs

- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260703-runtime_scheduling_scale.md`
- `docs/specs/20260710-self_improvement_evaluation_loop.md`
- `docs/specs/20260531-human_attention_intervention_model.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`

## Summary

The durable scheduler admits, places, and leases turns, but nothing in NanoCore can durably say "run this again tomorrow" or "run this once, soon, because an event happened". The only cron-shaped structure is an in-memory automation store with no persistence and no executor.

This spec adds a deliberately small trigger layer in front of the existing durable scheduler: durable schedule records carrying a precomputed `next_fire_at`, one dumb minute-granularity tick loop that queries due rows and enqueues admission entries, write-ahead fire records with typed outcomes, coalescing catch-up after downtime, and a one-shot convention that lets domain events reuse the same mechanism. The tick loop decides nothing; all scheduling intelligence stays in the records and in the existing scheduler.

This is the trigger substrate required by the self-improvement loop (scheduled reflection passes and event-triggered reflection) and by product automations.

## Goals / Non-goals

### Goals

- Make recurring and deferred work durable: schedules survive restart, and missed fires are handled by an explicit policy instead of being lost.
- Keep the tick loop trivially simple: one indexed query per tick, no cadence parsing at fire time, no execution.
- Reuse the durable scheduler unchanged: a fire produces a normal admission queue entry with intent-before-effect ordering preserved.
- Serve both trigger families of the self-improvement loop — cadence-based reflection and event-triggered reflection — with one mechanism.
- Replace the in-memory automation store with durable records in the same change, with no compatibility path.

### Non-goals

- Do not build a general workflow engine, DAG scheduler, or dependency graph. One schedule produces one turn intent per fire.
- Do not support sub-minute cadences. Minute granularity is the contract floor.
- Do not replay every missed occurrence after downtime. Catch-up coalesces.
- Do not implement metering enforcement. Budget-aware deferral is specified as behavior against a budget signal that other work must provide.
- Do not define distributed or multi-node tick coordination. The single-writer NanoCore posture of the durable scheduler applies.

## Background

Three forces motivate this spec.

First, `docs/specs/20260710-self_improvement_evaluation_loop.md` requires a trigger model: baseline scheduled idle-time reflection passes per workspace (default daily) via "the durable scheduler", plus event triggers where a redo request, negative feedback event, review rejection, or suite failure enqueues a targeted reflection. The durable scheduler as accepted has no recurring primitive; `docs/core/agent-workflow.md` explicitly lists "scheduled/cron-derived recurring work" as future capability.

Second, the product already gestures at automations: `apps/nanocore/src/lib/automation-store.ts` stores name, workspace, cron expression, prompt, and status — in a process-local `Map`, unpersisted, with no executor. This is a dead end that should be replaced, not extended.

Third, the durable scheduler's own design points at the right shape: intent is written before effect, loops are stateless between iterations relative to SQLite, and recovery rebuilds state from durable records. A trigger layer should follow the same discipline rather than invent a parallel one.

The design deliberately stores a precomputed `next_fire_at` per schedule instead of evaluating cadence expressions against the current minute. This makes the tick a single range query, makes downtime recovery automatic (overdue rows are simply due), and makes coalescing the natural catch-up behavior.

## Decision

- One new durable record family, **schedule records**, joins the scheduler coordination records in the server-scope database: recurring schedules and one-shot triggers, each carrying an authoritative `next_fire_at`.
- One new **tick loop** joins the existing scheduler service family (dispatch, lease-watch, probe). It runs on a fixed interval (default 60 seconds), queries due schedule rows, writes a fire record, enqueues an admission queue entry, and recomputes `next_fire_at`. It performs no other logic.
- **Catch-up coalesces.** However long NanoCore was down, an overdue schedule fires at most once when the tick resumes, and `next_fire_at` is recomputed from the current time.
- **Events are one-shot schedules.** Domain code that observes a triggering event inserts a one-shot schedule row (optionally deduplicated by key) with `next_fire_at` set to now. There is no separate event-subscription mechanism.
- The in-memory automation store is **deleted and replaced** by recurring schedule records in the same change, per the repository rule against internal backward compatibility.

## Contract / Expected Behavior

### Schedule record

A schedule record represents one durable intent to start turns in the future. It MUST carry:

- schedule id
- kind: `recurring` | `one-shot`
- owner scope: `server` | `workspace`, with workspace id when workspace-scoped
- origin: `user-automation` | `system` | `event`, with an origin reference (for `event`: the audit event or record that raised it; for `user-automation`: the configuring surface)
- turn intent: target workspace id, requested agent and profile reference, and the turn input to submit on fire (same captured shape the admission queue entry stores)
- priority class: `automation` or `maintenance` only; schedule fires MUST NOT claim `interactive`
- cadence expression (recurring only): an interval duration or a 5-field cron expression; minimum effective period one minute
- `next_fire_at`: the authoritative due timestamp; the only field the tick loop queries
- overlap policy: `skip` (default) | `wait`
- dedupe key (optional, one-shot only)
- status: `active`, `paused`, `completed` (one-shot fired terminally), `cancelled`
- last-fired-at timestamp and last fire record reference
- consecutive-failure count
- created/updated timestamps

Rules:

- `next_fire_at` is authoritative for dispatch. Cadence expressions are parsed only when a schedule is created, updated, or refired — never during the due-row query.
- Recurring schedules with a cadence whose effective period is under one minute MUST be rejected at creation with a typed error.
- A one-shot schedule with a dedupe key MUST NOT be inserted while another non-terminal one-shot with the same key exists in the same workspace scope; the insert is a no-op that returns the existing schedule (event coalescing).
- Paused schedules keep their `next_fire_at` but are excluded from the due-row query; resuming a schedule whose `next_fire_at` is in the past recomputes it from the current time for recurring schedules and fires promptly for one-shots.
- Schedule records are server-scope operational coordination records, like admission queue entries. Product surfaces MUST read them only through workspace-filtered derived read models.

### Fire record

A fire record is the write-ahead intent for one fire of one schedule. It MUST carry:

- fire id, schedule id, workspace id
- due timestamp (the `next_fire_at` that triggered it) and fired-at timestamp
- coalesced-occurrence count (number of cadence occurrences the fire represents; 1 in normal operation)
- outcome: `enqueued`, `skipped-overlap`, `deferred-budget`, `failed`
- admission queue entry id when `enqueued`
- typed failure reason when `failed`
- scheduler epoch

Rules:

- The tick loop MUST write the fire record before creating the admission queue entry, and MUST link the entry id back onto the fire record in the same transaction that creates the entry. This extends the durable scheduler's write-ahead-intent chain one link earlier: fire record → queue entry → plan → lease.
- Every tick-loop action carrying external effect MUST be stamped with the current scheduler epoch and is subject to the same epoch fencing as other scheduler records.
- A `failed` fire (for example, the turn intent no longer resolves to a valid agent) MUST increment the schedule's consecutive-failure count. A schedule reaching the failure threshold (default 5) moves to `paused` and MUST surface a human-actionable Action Center row.

### Tick loop

- The tick loop runs inside NanoCore beside the dispatch, lease-watch, and probe loops, on a fixed interval (default 60 seconds, configurable; MUST NOT be configured below the one-minute cadence floor's usefulness — sub-second ticks are pointless and disallowed below 5 seconds).
- Each tick executes: select active schedules with `next_fire_at <= now` (one indexed query), then for each due schedule apply the fire procedure below. A tick with no due rows MUST cost one query and nothing else.
- Fire procedure, per due schedule, in one transactional sequence per schedule:
  1. Overlap check: if the schedule's most recent `enqueued` fire has a non-terminal admission queue entry or a non-terminal lease for the turn it started, apply the overlap policy. `skip`: write a `skipped-overlap` fire record and recompute `next_fire_at`. `wait`: leave `next_fire_at` unchanged and do nothing; the next tick retries.
  2. Budget check: when a budget signal for the schedule's consumption category reports exhaustion, write a `deferred-budget` fire record and set `next_fire_at` to now plus a backoff (default 10 minutes) so the loop does not spin. Until metering enforcement exists, this check trivially passes (see Deferred / Future Work).
  3. Enqueue: write the fire record, create the admission queue entry from the stored turn intent with the schedule's priority class, and link the entry id.
  4. Advance: for `recurring`, recompute `next_fire_at` as the next cadence occurrence strictly after the current time (not after the previous due time), recording the number of skipped occurrences as the fire's coalesced count. For `one-shot`, move the schedule to `completed`.
- The tick loop MUST be stateless between iterations relative to SQLite. Timers, cursors, and in-flight sets MUST be derivable from durable rows.

### Catch-up and recovery

- Coalescing is the only catch-up behavior: after any downtime, each overdue schedule fires at most once, with the missed-occurrence count recorded on the fire record. The system MUST NOT replay one fire per missed occurrence.
- On NanoCore startup, the tick loop runs a first iteration after scheduler restart recovery completes (new epoch minted, leases re-adopted). Overdue schedules are simply due rows at that point; no dedicated recovery scan is needed.
- A fire record in `enqueued` state whose linked admission entry does not exist (crash between the two writes) is an intent without effect: startup recovery MUST re-drive the enqueue for it, idempotently, under the new epoch. Because the fire record is written first, the crash window can never produce an admission entry without a fire record.

### Event-trigger convention

Domain code that observes a triggering event creates a one-shot schedule rather than calling any new API surface. The convention:

- Producers: acceptance of a redo request, a review `rejected` verdict, an explicit negative feedback event, and a regression-suite failure reported by the Evaluation Harness are the initial producers, per the self-improvement spec's trigger model. Additional producers MAY adopt the same convention.
- Each producer inserts a one-shot schedule with origin `event`, an origin reference to the raising record, `next_fire_at = now`, priority class `maintenance`, and a dedupe key scoped to the target (for example, thread id plus trigger type), so an event burst on one thread coalesces into one reflection.
- Producers MUST NOT start turns directly for these triggers; routing every trigger through schedule records keeps budget deferral, overlap policy, coalescing, audit, and Action Center failure surfacing uniform.

### Automation store replacement

- `AutomationRecord` and the in-memory `AutomationStore` are removed. Product automations become recurring schedule records with origin `user-automation` and priority class `automation`.
- The existing automation App API routes are re-pointed at the workspace-filtered schedule read model and governed create/update/pause/cancel operations. No compatibility layer is kept for the old shapes, per the repository rule.

### Audit

- Schedule creation, update, pause, resume, cancellation, and every fire outcome MUST produce audit events under `docs/core/audit.md` categories, carrying schedule id, fire id, and (when present) admission entry lineage.

## Proposed Design

Implementation follows the existing scheduler service pattern: a `scheduler_schedules` table and a `scheduler_schedule_fires` table beside the existing scheduler records; a helper layer in the scheduler records module for create/update/due-query/fire-transaction; and a `scheduler-tick-loop` runtime service registered with the other scheduler services in `apps/nanocore/src/index.ts`, started after restart recovery and stopped during orderly shutdown. Cadence parsing (interval and 5-field cron) is one pure, unit-testable function that maps (expression, from-time) to next occurrence. Reflection cadence defaults for the self-improvement loop are seeded as `system`-origin recurring schedules when that feature ships; nothing in this spec creates them.

## Current Implementation Projection

Nothing in this contract is implemented. Current adjacent state: `apps/nanocore/src/lib/automation-store.ts` holds unpersisted automation definitions with cron fields and no executor (to be deleted by this spec); `apps/nanocore/src/runtime/scheduler-dispatch-loop.ts`, `scheduler-lease-watch-loop.ts`, and `scheduler-health-probe-loop.ts` establish the loop pattern the tick loop joins; `apps/nanocore/src/scheduler-records.ts` is the helper layer the schedule/fire helpers extend; admission queue entries and their write-ahead ordering are implemented per `docs/specs/20260703-durable_scheduler_design.md`.

## Alternatives Considered

- Cron-expression matching against the current minute at tick time. Rejected: requires evaluating every active schedule every tick, makes downtime handling a special case, and turns coalescing into extra logic. A stored `next_fire_at` makes the tick one range query and makes catch-up automatic.
- A dedicated event bus for redo/feedback/rejection subscriptions. Rejected for this scope: the consumers are turn starts, which the schedule mechanism already produces; a bus adds a second delivery mechanism with its own durability, replay, and ordering questions. One-shot rows with dedupe keys deliver the required behavior with records that already fit scheduler recovery.
- Replaying all missed occurrences after downtime. Rejected: for reflection passes and automations, N missed daily runs collapse into one meaningful run; replay multiplies cost with no added signal and can flood the queue at startup.
- Extending the in-memory automation store with persistence. Rejected: it would duplicate scheduler record discipline (epochs, write-ahead intent, recovery) in a second home; the internal-development rule prefers clean replacement.
- Per-schedule OS timers instead of a polling tick. Rejected: timers are process state that must be rebuilt on restart anyway; the durable rows are the source of truth, so a polling tick over an index is simpler and equally accurate at minute granularity.

## Consequences

- The self-improvement loop's entire trigger model (cadence plus events) lands on one mechanism, and its budget-cap "queue rather than run" rule gets a concrete enforcement point (the fire procedure's budget check).
- Product automations become durable and observable (fire history, typed outcomes, Action Center on repeated failure) instead of silently nonexistent.
- The scheduler service family grows a fourth loop; the tick adds one indexed query per minute in steady state, negligible on SQLite.
- Event producers take a hard dependency on schedule-record insertion, which couples those code paths to Core DB availability — the same dependency turn admission already has.

## Rollout / Migration Plan

New machinery, no compatibility migration. Order: (1) schedule and fire record layer with cadence parsing and unit-tested next-occurrence math; (2) tick loop with fire procedure, overlap skip, coalescing catch-up, and epoch stamping; (3) automation store deletion and App API re-pointing; (4) event-trigger convention adopted by the initial producers; (5) budget-check activation when metering enforcement ships. The in-memory automation store has no persisted data, so there is nothing to migrate.

## Testing Strategy / Acceptance Criteria

Mapped to the L0-L6 model in `docs/specs/20260529-test_strategy.md`:

- L0: schema-drift checks for schedule and fire record shapes; repository check that the automation store module is gone.
- L1: unit tests for next-occurrence math (interval and cron, DST boundaries, minimum-period rejection), coalesced-count computation, overlap-policy selection, dedupe-key no-op insertion, failure-threshold pause, and budget-backoff `next_fire_at` advancement.
- L2: contract tests that a fire produces an admission queue entry with the stored turn intent, correct priority class, and fire-to-entry linkage in one transaction; that `interactive` is unclaimable; and that fire records carry the current epoch.
- L3: NanoCore black-box tests: a recurring schedule fires and its turn completes; kill NanoCore with an overdue schedule and assert exactly one coalesced fire on restart with the missed count recorded; crash between fire record and admission entry and assert idempotent re-drive; overlap `skip` and `wait` behavior against a long-running fired turn; an event producer inserting a deduped one-shot that fires once for a burst of three events.
- L5: smoke test that a packaged build creates one recurring schedule and observes one fire through the durable path.
- L6: story acceptance covering a user configuring a daily automation, seeing it run, stopping the server overnight, and finding one coalesced run (not N) plus an intact fire history the next day.

Acceptance criteria: all L1-L3 behaviors pass deterministically; a crash at any single point in the fire sequence recovers with no lost intent and no duplicate admission entry; the tick loop performs exactly one query on an idle tick; no schedule record exposes turn input or workspace paths through product read models beyond what admission entries already expose.

## Risks & Mitigations

- Risk: a burst of due schedules at startup (long downtime) floods the admission queue. Mitigation: coalescing bounds fires to one per schedule; pool queue limits and `maintenance`/`automation` class ordering already protect interactive traffic; the tick MAY bound fires per iteration and let the next tick continue.
- Risk: cadence parsing bugs silently skew `next_fire_at`. Mitigation: next-occurrence math is a pure function with exhaustive L1 coverage; fire records preserve due timestamps so drift is observable in history.
- Risk: overlap `wait` starves a schedule forever behind a stuck turn. Mitigation: the stuck turn is already surfaced by lease staleness and Action Center; `wait` schedules show their unchanged `next_fire_at` in the read model; the failure threshold does not apply (no fire occurred), so documentation of `skip` as default matters.
- Risk: event producers bypass the convention and start turns directly. Mitigation: contract rule above plus review checklist; the self-improvement spec's producers are specified to insert trigger rows.

## Open Questions

- [Non-blocking] Whether one-shot event triggers should carry a structured event payload on the schedule record, or only the origin reference for the consumer to dereference. Current lean: origin reference only, keeping schedule records small.
- [Non-blocking] Whether workspace-filtered schedule read models should expose fire history inline or as a separate paged projection. Affects App API shape only.

## Deferred / Future Work

- Budget-check activation: the fire procedure's budget check is specified here but inert until metering enforcement and the self-improvement consumption category exist (`docs/core/metering.md`, `docs/specs/20260710-self_improvement_evaluation_loop.md` Resolved Design Questions).
- Idle-awareness: the self-improvement spec describes reflection as "idle-time"; a load-aware tick that defers `maintenance` fires while interactive load is high is future work — the priority-class ordering of the durable scheduler is the V1 approximation.
- Jitter and spread for many workspaces sharing the same cadence (avoid synchronized daily storms in multi-workspace deployments).
- Web UI schedule management surfaces beyond re-pointed automation routes.
- Multi-node tick coordination, following whatever multi-node design the durable scheduler eventually adopts.

## Links

- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260703-runtime_scheduling_scale.md`
- `docs/specs/20260710-self_improvement_evaluation_loop.md`
- `docs/specs/20260531-human_attention_intervention_model.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260529-test_strategy.md`
