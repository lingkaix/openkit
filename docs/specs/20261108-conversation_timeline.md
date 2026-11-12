---
status: Accepted
implementation: In Progress
kind: boundary
date: "2026-11-08"
---
# Conversation Timeline

## Owns

This specification owns the conversation timeline that every OpenKit agent kind presents to people: run entries, the entry-kind registry with its agent profiles and Work and Full lens policies, the Needs you and Now surfaces, catch-up, compression, timeline object references, back-links and in-app toasts, intervention states and their consequence copy, the UI rules with their checks, loading budgets, degraded states, the phone layout, and the bounded read models the timeline requires from NanoCore.

## Does Not Own

- [Work Model](../core/work-model.md) owns Thread, Turn, Item, Task, Goal and conversation semantics. [Core Protocol](../core/protocol.md) owns Item types, events and replay.
- [Web Product Surface Projection](20260628-web_product_surface_projection.md) owns publication through the Web product, routes, the account gate and the projection rules this timeline reuses. [Web UI Rebuild Stack](20260710-web_ui_rebuild_stack.md) owns component and client-state placement.
- [Unified Conversation Composer](20260831-unified_conversation_composer.md) owns the Composer, target selection, submission and explicit live input. This specification owns only how sent input and its states render in the timeline.
- [Pending Requests](20260930-pending_requests.md) owns request lifecycle, exact effect disclosure, blocking and delivery. [Human Attention](20260531-human_attention_intervention_model.md) owns attention gates, Action Center rows and delivery policies.
- [Thread Visibility](20260909-thread_visibility_and_sharing.md) owns audience. [Task Mode](20260704-task_mode_worker_delegation.md#live-steer) owns `task.steer`, its receipts and its races. [Goal](20261002-goal.md) owns the board, Plan versions and completion.
- [Work Resource Interaction](20260713-work_resource_interaction_model.md) owns Artifact versions and reviews. [Evaluation Foundation](20261017-evaluation_foundation.md) owns judgement records. [NanoCore Interception And Information Consolidation](20261018-nanocore_interception_and_information_consolidation.md) owns the Decision Trace projection.
- [Storage Layout](20260703-storage_layout_record_ownership.md) and [Durable Execution And Control Store](20261019-durable_execution_and_control_store.md) own storage layout and the Thread-scoped storage index.
- This specification adds no durable record, record owner, protocol object, renderer plugin system or client-side delivery queue. No timeline view becomes an authority.

## Core References

- [Work Model](../core/work-model.md)
- [Core Concepts](../core/core-concepts.md)
- [Communication](../core/communication.md)
- [Evidence](../core/evidence.md)
- [Core Protocol](../core/protocol.md)
- [Policy](../core/policy.md)
- [Identity](../core/identity.md)

## Summary

Agents produce far more than a person can read. The timeline compresses a Thread's records into what a supervisor needs, and every summary opens back to its exact records. It serves the Personal Assistant, Task Workers, Goal Coordinators, the Knowledge Manager, Administration, custom agents and, later, shared chat.

- **Five questions, in order:** Do I need to act? Is it OK now? Is it still doing what I asked? What changed since I looked? What did it produce, and how? The first four need no scrolling.
- **One switch, Work | Full.** Work shows messages, decisions, outputs, outcomes and one summary line per run. Full adds every step in place, an environment line, proved policy badges and sub-agent lines. Decisions, errors and outcomes render identically in both.
- **One run is one entry.** A long or running run shows its plan, its latest progress notes and segments where the plan step changes.
- **Two pinned surfaces.** *Needs you* puts blocking decisions first. *Now* shows the step in progress with its elapsed time.
- **Alignment and catch-up.** The Task header shows the objective and plan progress; a Goal shows its board. A divider marks what is new since the viewer was here.
- **Shaped agent output.** Five reporting rules go into built-in agent prompts and the Worker Context Package.
- **Truthful sending.** Input reaches the agent as fast as possible. Steer has four honest states. The client never queues anything itself.
- **One mechanism.** One pipeline and one typed registry of every entry kind; each agent kind is a declarative profile; Work and Full are policies over the registry.
- **The timeline is the hub.** Every object opens its own surface at the exact place through one resolver, and those surfaces link back. Needs you, Action Center and toasts are three views of one attention source.
- **Cost follows attention.** Paged windows, bounded previews and a bounded dashboard replace whole-history reads.

## Goals / Non-goals

Goals:

- Show who is responsible, how far the work has gone, what was communicated and handed off, which outputs exist and when to step in, as the [Product Vision](../product-vision.md) requires of supervision surfaces.
- Let a person **understand** the state of work with little reading, **trust** it in proportion to the evidence, **decide and intervene** with the consequence in view, and **record judgement** against exact outputs.
- Serve every agent kind with one backbone and one mechanism, so a new agent kind costs a profile, not a screen.
- Keep read cost proportional to what is on screen, not to history length.

Non-goals:

- A separate technical UI. Depth is a lens over the same entries.
- Generated catch-up prose, shared-chat addressing, a multi-Thread board, keyboard shortcuts and a single take-over action in v0.1.0 (see [Deferred / Future Work](#deferred--future-work)).
- New durable records, owners or protocol objects. Every view derives from existing owners.
- Any client-side queueing, delay or replay of input.

## Background

The scarce resources are attention (a run can produce hundreds of steps an hour), working memory (about four chunks), judgement quality (approval fatigue erodes it), spatial memory (unrequested jumps destroy it) and, on phones, screen space, battery and network.

Before this specification, Web read and repolled a Thread's whole history every 5 seconds, listed every step of the Thread in one Details panel, showed raw identifiers in prose and on the Goal screen, rendered each Item type through scattered per-kind logic, and had no paging. The Goal screen showed no Coordinator narrative. [Current Implementation Projection](#current-implementation-projection) records the code facts.

## Decision

The following product decisions are accepted (2026-11-08) and govern this contract. The [Conversation Timeline Rulings](../decisions/20261108-conversation_timeline_rulings.md) record the engineer rulings among them and their reasons.

1. **One timeline mechanism** for every agent kind: a registry of entry kinds, declarative agent profiles and lens policies, with no plugin system and no new protocol object.
2. **Work | Full** is one switch over the same entries, not two interfaces.
3. **Live steer per adapter.** `task.steer` is in v0.1.0 and is enabled per Worker adapter after qualification: Codex and Pi first, then OpenCode if its inbox qualifies. DeepSeek is unsupported. Workers on other adapters offer *Keep draft* and *Stop*.
4. **Personal Assistant handoff state.** The Personal Assistant's "Started a Task" line shows that Task's current state. It is a view of existing records, not a result card.
5. **No queued follow-up in v0.1.0.** Delivery stays optimistic: a message reaches the agent as fast as possible, through steer where the adapter supports it. The first item after v0.1.0 is a Core-held follow-up ([#643](https://github.com/lingkaix/openkit/issues/643)): NanoCore holds a message sent during a run and delivers it through the ordinary Send path when the run ends. When the run ends failed, stopped or waiting for a decision, the message stays held with its reason, and the person chooses Send now, Edit or Cancel.
6. **Reporting rules within the built-in prompt cap.** The Goal Coordinator prompt is trimmed first; its cap is raised only if trimming cannot fit the rules.
7. **Toast scope.** In v0.1.0, toasts fire only for decisions that are or become blocking, and for failures that already raise an attention row and concern work the viewer waits on, plus the existing handoff toast. Other failure toasts and opted-in completion toasts wait for a Thread event stream ([#644](https://github.com/lingkaix/openkit/issues/644)).
8. **v0.1.0 scope.** Both the Minimal tier and the Extended tier of [Rollout / Migration Plan](#rollout--migration-plan) are in v0.1.0 and are delivered in slice order. After-v0.1.0 items stay deferred with their issues.
9. **Settled vocabulary and state.** "Run" is the word for a Turn in user-facing prose. The catch-up anchor is derived, at the level of a single Item. `thread.timeline` is a new read. The lens is remembered per device.

## Contract / Expected Behavior

### Principles

- **P1.** Answer the five questions in order.
- **P2.** Never lose a decision. Summarize process by default.
- **P3.** Every summary keeps its sources. Generated text is labeled.
- **P4.** System facts look different from agent claims, and sit next to them.
- **P5.** Truthful state: unknown, stale and sending are shown as such.
- **P6.** Show the consequence before the action.
- **P7.** Calm by default. Only blocking decisions, failure of work you wait on and, after v0.1.0, completion you opted into interrupt. One accent color means "needs you"; red means a problem you can act on.
- **P8.** One backbone and one mechanism for every agent kind.
- **P9.** Stable space: nothing moves the reader without the reader's action.
- **P10.** Cost follows attention, not history length.
- **P11.** Shape what agents write.
- **P12.** The timeline is the hub: every object opens its surface, and every surface links back.

| # | Question | Answered by | Needs scrolling |
| --- | --- | --- | --- |
| 1 | Do I need to act? | Needs-you bar | No |
| 2 | Is it OK now? | Now strip | No |
| 3 | Is it still doing what I asked? | Header objective and plan; Goal board | No |
| 4 | What changed since I looked? | Divider and digest | No, on open |
| 5 | What did it produce, and how? | Outcome lines and output cards; Full; Inspector | Within the first window, then one action |

### Situations

| Situation | Arrives from | Needs first | Done when |
| --- | --- | --- | --- |
| S1 Returning after hours or days | List row: Needs you, Failed, Done, Running | What waits; on track?; what is new | Next action decided without reading steps |
| S2 Approve or answer only | Toast, notification, Action Center, Discord | The decision, with context and consequence | Decided; on to the next |
| S3 Live supervision | Open Thread, in Full | What it does now; moving?; on track? | Steered, stopped or satisfied |
| S4 Personal Assistant chat | Home | The answer | Answered or handed off |
| S5 Several people | Shared Task or Goal; shared chat later | Who said and decided what | Same as above |
| S6 Long Goal | Goal screen | Cards, plan, decisions across Tasks | Approved, edited or accepted |
| S7 Knowledge Manager | Knowledge Manager conversation, scheduled upkeep | What knowledge changed, on what sources | Proposals reviewed |
| S8 Administrator | Administration entry | The exact change, its impact, the result | Applied or rejected |

Non-technical users stay in Work and reach the Inspector only through "What went wrong?". Technical users switch to Full. Phone and desktop differ in layout, not in information.

**S1, returning to a Task that has run for 3 hours.** The list row says "Running · 1 needs you". The header shows the objective ("Fix the CSV export so dates use the Workspace time zone") and plan progress ("3 of 5 done · now: Update tests"). Needs you says "Work continues meanwhile: Choose a date format for exports"; Now says "Running a command · 4 min". The timeline opens at the catch-up anchor inside the running run, "New since 10:40", with a digest above it: "1 plan step finished · 6 notes · 2 commands failed then passed · 1 question". The person reads three notes, answers the question and leaves.

**S2, approve-only.** A toast or notification says "Approve publishing the weekly summary · Weekly notes · Open". The decision sheet shows the title; who asked, and where; why policy asks; the complete exact effect (Approve stays disabled until it is shown); whether work waits; the age and runs since; and what Approve and Deny each do. Approve closes the sheet with "Approved by you". The row later shows the recorded result ("Posted", "Failed" or "Outcome unknown"). The sheet offers "Next decision (2 more)".

**S3, live supervision.** Full is on. The environment line reads "Sandbox: heartbeat 20 s ago · local | Standard → provider model | this run ≈ 410k tokens". Steps stream in place; scrolling up stops follow mode and shows "↓ 12 new". When the person types, Send becomes **Steer** with its consequence line, and the message moves from *Sending* to *Accepted by the running worker*. If the adapter cannot steer, the draft is kept and Stop is offered.

**S4, Personal Assistant.** Opens at the latest message. An answer streams with "Used 3 notes". Real work produces "Started a Task: Fix the CSV export ›" with that Task's current state.

**S5, several people.** Every human item names its author and every decision who decided. A second answer sees "Already answered by Sam at 10:31". Shared chat later adds addressing, queued simultaneous requests and an audience line ([#647](https://github.com/lingkaix/openkit/issues/647)).

**S6, long Goal.** The board shows card and Task states. Needs you merges the Goal's and its Tasks' decisions, labeled by Task. The Coordinator narrative sits below. A card edit says "This does not change running Tasks."

**S7, Knowledge Manager.** Cited answers; "Knowledge changes" outputs with diffs linking back to their run; proposals in Needs you; upkeep runs read "Scheduled knowledge upkeep".

**S8, Administrator.** A whole-server banner; candidates with before and after, validation and impact; Apply confirmed, then *Saved*, then *Reloaded* or *Needs restart*. An unknown result says "Check before applying again".

### Work And Full Lenses

The same person needs both depths within minutes, so depth is one switch, not two interfaces. Work and Full are two lens policies over one registry. The toggle sits in the timeline header and is remembered per device. A single run can be expanded to Full while the lens is Work.

| | Work (default) | Full |
| --- | --- | --- |
| Messages, decisions, outputs, handoffs, outcomes, errors, unknowns | Yes | Identical (lens invariant) |
| Run summary line; long-run plan and notes | Yes | Yes |
| Every step in place: tool calls, commands with output tail, file changes, reasoning summaries, all notes | Collapsed | Shown |
| **Environment line**: last Sandbox observation, logical model and route with fallback, usage this run | Plain status only when it explains a wait | Standing, in the header |
| **Policy badges** on steps that crossed an OpenKit boundary | No | Yes |
| Reported sub-agent lines | No | Grouped |
| Run timings, model and effort | No | Yes |
| Identifiers, raw outputs, audit link, worker-reported markers | Inspector | Inspector |

Full and the Inspector change depth, never access.

#### Environment Line

| Field | Source |
| --- | --- |
| Last Sandbox observation | The latest runtime evidence record for the run: phase, outcome, placement and time |
| Route and fallback | Route lineage on the run's LLM capability calls |
| Usage this run | Usage records that carry the run's Turn |

- **Observation, not liveness.** Runtime evidence records observations (create, heartbeat, teardown, backend error), not a current state. The line shows the last observation with its age ("heartbeat 20 s ago", "torn down 3 min ago") and MUST NOT say "running". A current-state claim requires an authoritative lifecycle source with a freshness rule.
- A missing part shows "unavailable" (G11).
- **Authorization per source.** Usage and audit fields require `audit.read`. Runtime and configuration fields follow the allowlist in [Web Product Surface Projection](20260628-web_product_surface_projection.md#authority-and-projection-boundary).

#### Policy Badges

Only steps that went through the Gateway or caused an external effect get a badge. Inside the Sandbox, Workers have full permission ([Full Permission Inside The Sandbox](../decisions/20260930-full_permission_inside_the_sandbox.md), [Sandbox Full-Capability Rulings](../decisions/20261001-sandbox_full_capability_rulings.md)), so in-Sandbox commands and file edits have no policy decision and MUST NOT show one.

Badge values are *Allowed by policy*, *Approved by Sam*, *Denied by policy* and *Waiting for approval*, plus the connection used ("via GitHub (team connection)"), never a credential identifier.

A badge shows only a proved state. Tool-call Items carry no policy outcome; CapabilityCall status records execution only; a policy invocation records a participant outcome, not a permission decision; and a waiting approval's raising call is recorded as denied ([Pending Requests](20260930-pending_requests.md#raise)). A badge therefore requires the exact lineage: the PermissionDecision for the call and, for approvals, the Pending Request with its resolution actor and execution call. Missing linkage, including calls without Item attribution, shows no badge. No outcome record is added (G12). Audit rows stay behind the Inspector link, as [Evidence](../core/evidence.md#audit-source-of-truth) requires.

### Run Entries

`Workspace → Thread → Turn → Item[]` stays the backbone, and no record is added. One **run entry** renders one Turn:

```text
Trigger line      who or what started it, when (omitted when it is the viewer's message just above)
Human input       the message(s) that started it
Narrative items   decisions, handoffs, outputs, generative UI, warnings and errors, in order
Summary line      "Worker · worked 14 min · 37 steps · 6 files changed · 2 commands failed"
Plan + notes      long runs only
Final message     last agent message, in full (completed runs)
Outcome line      only if not a plain success: "Stopped by Sam"; "Failed: <cause> [owner's actions] [Details]"
Judgement         rating; review, select, refine and redo on outputs
```

- **Ordering.** Runs follow admission order; Items follow their order within the run. A not-yet-started run MUST NOT sort first (G9).
- **Who stopped it.** "Stopped by Sam" comes only from the recorded `turn.interrupt` AuditEvent actor through authorized lineage ([Recorded Interruption Identity](20260628-web_product_surface_projection.md#recorded-interruption-identity)), never from the viewer or the trigger actor. Otherwise the line says "Stopped", and the Inspector says "actor not recorded". *Stopping…* stays until the run's terminal status arrives; command acceptance is not termination.
- **Bounded narrative.** A Turn may hold any number of messages, inputs and outputs. An entry carries a bounded narrative window (the final message, the latest notes and up to 20 further narrative Items within the payload budget) plus counts and a continuation. Earlier narrative Items page through the Level-2 window. Pending decisions stay reachable through Needs you without embedding every historical card.

### Long And Running Runs

A run counts as long when it is still running, lasted 30 minutes or more, or has more than 100 steps. These thresholds are calibrated on real runs.

A long run adds, in Work:

1. **The latest plan as a checklist.**
2. **The latest three agent messages as progress notes.** Older ones go under "Earlier notes (n)". A running run has no final message yet, so these notes are its narrative.
3. **Segments where a plan step becomes in progress.** The current segment is open. Finished segments collapse to one line: "✓ Fix formatter · 41 min · 380 steps". Without a plan there are no segments, but notes still show.

```text
│ Worker · running 3 h 12 min · 1,240 steps · 31 files changed · 4 commands failed           │
│   Plan  ✓ Reproduce  ✓ Fix formatter  ● Update tests  ○ Docs  ○ Final check                 │
│   ✓ Reproduce · 20 min · 96 steps          ✓ Fix formatter · 41 min · 380 steps     [show]  │
│   ● Update tests · 1 h 50 min so far · 764 steps                                            │
│     Note 12:10  Fixture loader rewritten; 3 of 7 export tests pass.                         │
│   ─────────────────────── New since 12:40 ───────────────────────                           │
│     Note 13:05  Leap-day fixtures fixed; 6 of 7 pass.                                       │
│     Note 14:31  Last failure is time-zone related; switching fixtures to UTC.               │
│     ● Question: Which date format should exports use? (work continues)           [Answer]   │
```

**Sub-agents (Full only).** The source is the run's reported runtime activity: child-started, progress, result and failure entries with optional labels of at most 80 characters, at most 50 entries per run. Entries group by label ("Sub-agent tests · 6 updates · latest: …"); unlabeled entries go under "Other reported activity". Every group is marked "reported by the worker".

The catch-up anchor, other anchors and step windows work at the level of a single Item inside a run.

### Needs You

**Rows.** All attention rows for this Thread, or for the Goal and its linked Tasks: approval, question, Plan approval, completion acceptance, Artifact Review, Workspace Sync Review, Knowledge Proposal and recovery choice. Each row shows a verb-first title; "Work is waiting" when it blocks (the raising run has ended and no later run has started, per [Blocking And Presentation](20260930-pending_requests.md#blocking-and-presentation)); its age; and, on a Goal, its Task. Blocking rows come first, then oldest first.

**Behaviour.** Several rows collapse into one line: "3 need you · Next: … ›". Selecting a row with a timeline anchor (Thread, Turn, Item) scrolls to its card in place and focuses it. Rows without one, such as Workspace reviews and recovery, open their owning surface; no Item or request identifier is invented. A row leaves the bar only when the authoritative outcome arrives.

**Source.** The same rows, from the same attention projection, also feed Action Center and toasts. Rows already carry `blocking`, `ageSeconds` and `turnsSince`; the timeline reuses them and computes nothing itself (G6).

### Now

| State | When | Example |
| --- | --- | --- |
| Hidden | Idle | Header: "Finished 3 h ago" |
| Waiting to start | Run pending or queued | "Waiting for a free worker · 2 ahead" |
| Step in progress | A step Item is in progress | "Running a command · 12 min"; "Using GitHub: create issue · 40 s" |
| Thinking or writing | Running, no step in progress | "Thinking · 2 min" |
| Quiet | No step in progress, and no event within T | "Running 40 min · no activity for 12 min" |
| Waiting for you | A blocking request exists | "Waiting for you · 1 decision" (accent) |
| Stopping | Stop pressed, final state not yet seen | "Stopping…" |
| Ended with a problem | Latest run failed or was stopped within 24 h | "Stopped 20 min ago: tests failed" |
| Status unavailable | Reads failing | "Status unavailable · last known: running at 10:42" |

| Situation | Quiet threshold T |
| --- | --- |
| A step is in progress | Never Quiet; only elapsed time is shown |
| Model call, effort up to medium | 5 min |
| Model call, effort high or above | 10 min |
| Adapter reports steps only when they finish | 30 min, and the label says "Working" |

Quiet states a fact; it is not a diagnosis. The server supplies the Now fields (G5).

### New Since You Were Here

**Catch-up anchor.** B is the newer of the newest message Item in the viewer's display receipts and the viewer's own newest action. B is an Item, so it can fall inside a running run. Completed progress notes are eligible for receipts, so long runs get fine-grained anchors. No new state is stored in v0.1.0.

**B is not proof of reading.** Receipts are the set of messages actually displayed ([User-owned Read Receipts](20260628-web_product_surface_projection.md#user-owned-read-receipts)). A person may jump to a decision or steer without reading earlier notes. Unread marks therefore come from the receipt set, not from B: unread messages before B keep their mark, and the divider row offers "3 earlier unread ›", which jumps to the oldest one.

`thread.timeline` catch-up data may include `earlierUnread`. A null overall result means the fixed probe could not prove the answer. The fixed bounds are documented with the implementation; this specification does not claim that those bounds have landed. When present, the object is `{ count, capped, oldest }`, where `oldest` is `{ turnId, itemId }` for the exact oldest eligible unread message before B, or null when none exists. A proved empty result has `count: 0`, `capped: false`, and `oldest: null`. `count` is exact up to 100. `capped` is true only when a 101st unread message is proved. The read returns no partial count, stores no new durable state, and adds no index. It reuses the existing receipt-eligibility rule. The Web shows the count only when the object is present, and shows an oldest-item jump only when `oldest` is non-null. It keeps its honest fallback, with no count and no oldest Item, when the result is null.

A run that ends without a message stays "new" until the viewer acts. A seen-through marker is deferred ([#649](https://github.com/lingkaix/openkit/issues/649)).

**Opening rule.**

1. An explicit anchor wins.
2. Otherwise, if the new content is longer than one screen, open at the divider at B, inside the run if B is there.
3. Otherwise, open at the end, following new items.

**Digest.** At most 7 lines of counts with links, computed deterministically by the server from B: needs you; runs finished and outputs; plan steps finished; problems; decisions by others; new messages. The server computes it because the client cannot count without loading everything, and phone and desktop must agree. Generated prose is deferred ([#646](https://github.com/lingkaix/openkit/issues/646)).

### Compression Rules

All rules are deterministic, apply only to presentation and are reversible.

| Rule | Folds | Display | By |
| --- | --- | --- | --- |
| R1 | All steps of a run, in Work | Summary line | Server statistics |
| R2 | Consecutive same-tool calls or file changes | "Read 9 files" | Client |
| R3 | 3 or more consecutive calls with the same tool and arguments | "Checked CI status 12× over 6 min · last: failing" | Client, using an argument digest (Extended tier) |
| R4 | A failed call followed by the same call | "Tried 3×, succeeded on the 3rd" | Client |
| R5 | Earlier agent messages | Short runs: notes among steps. Long runs: latest 3 visible | Client |
| R6 | Plans other than the latest | Latest checklist only | Client |
| R7 | Context summaries and knowledge injections | "Used N sources" | Client |
| R8 | Closed decisions | One line: who decided, plus the recorded result (executed, consumed, delivered) when it exists | Client |
| R9 | **Never folded:** pending decisions; granted decisions whose effect failed, is unknown or is not yet consumed; errors that ended a run; unknown outcomes; outputs; human messages | – | – |

Every group expands to exactly the items it contains. A group split by a page boundary continues as "…and 14 more".

### Claims, Evidence And Judgement

The recorded summary line ("2 commands failed · last command exit 1") sits directly above the agent's claim ("All tests pass"), so a contradiction is visible without reading steps. The timeline does not judge the contradiction; the person does.

Rating (`turn.feedback`), Artifact Review, candidate selection and Knowledge Proposal decisions sit on the exact output version they judge. Inline correction judgements are deferred ([#653](https://github.com/lingkaix/openkit/issues/653)).

### Registry, Profiles And Lens Policies

Agent kinds and the two lenses differ only in configuration. They share one pipeline, one typed registry and one set of components.

```text
Records         Turn, Item, Pending Request, Artifact, runtime evidence, CapabilityCall, audit
   │  server read model (TB2, TB4): run entries, step windows, statistics, attention rows, Now, catch-up anchor
   ▼
Entry model     TimelineEntry { header, narrative[], notes[], plan, stats, stepWindow, outcome }  ← TimelineSource adapter
   │  resolve(kind) = registry[kind] × lensPolicy × agentProfile → RenderDecision
   ▼
RenderDecision  { voice, disclosure, compression, attention, links[], copyKey }
   │
   ▼
Components      RunEntry, NarrativeItem, StepRow, FoldGroup, DecisionCard, OutputCard, FactLine, Badge, ObjectLink
```

The `TimelineSource` adapter starts on today's reads (`thread.dashboard`, `thread.items`) and switches to `thread.timeline` once TB2 lands; components never see the difference. Per-kind rendering logic moves into the registry.

#### The Registry

One typed table in Web, one row per *entry kind*. It covers every protocol Item type and the non-Item entries the timeline shows, and it is the single source of truth for how each kind renders.

Columns: *Cat.* is the voice category (U1): human, claim, fact, decision, output, process or derived. *Work* and *Full* give the disclosure: shown, counted, folded, Inspector-only, or – (hidden). *Compr.* names the compression rule. *Attention* is none, ambient (bars and counts) or interrupt (may toast). *Links* are object references. Every row also has a copy key into one copy module, which a lint checks (U11).

| Entry kind | Cat. | Work | Full | Compr. | Attention | Links |
| --- | --- | --- | --- | --- | --- | --- |
| `user-message` (steer: with its receipt state) | human | shown | shown | – | none | – |
| `assistant-message` (final) | claim | shown | shown | – | none | – |
| `assistant-message` (earlier) | claim | short run: folded; long run: latest 3 | shown | R5 | ambient (newest feeds Now) | – |
| `plan` | claim | latest shown | all | R6 | ambient (header) | – |
| `reasoning` | process | – | shown (summary) | – | none | – |
| `context-summary` | derived | – | marker | – | none | Inspector |
| `knowledge-injection` | fact | "Used N sources" | row | R7 | none | knowledge page |
| `tool-call` | process | counted | row + badge | R2–R4 | none | audit (call), connection, Gateway |
| `command-execution` | process | counted | row + tail | R2, R4 | none | full body |
| `file-change` | process | counted | grouped | R2 | none | – |
| `artifact-reference` | output | card | card | – | none (a pending review is its own row) | output at version |
| `approval-request` + decision + disposition | decision | card | card | R8 closed | interrupt if blocking, else ambient | attention row, audit, exact effect |
| `user-input-request` + response | decision | card | card | R8 closed | interrupt if blocking, else ambient | attention row |
| `agent-handoff` | fact | shown + current state | shown | – | none | linked Task |
| `status` (error, warning) | fact | shown | shown | – | ambient | fix surface (error actions) |
| `status` (info) | fact | knowledge results only | shown | – | none | knowledge diff |
| `generative-ui-reference` | output | shown | shown | – | none | – |
| Run trigger | fact | shown | shown | – | none | source: automation, request, earlier run |
| Run outcome (failed, interrupted, cancelled, unknown) | fact | shown | shown | never | interrupt if the work is yours | audit (run), fix surface |
| Run queued | fact | Now | Now | – | ambient | – |
| Runtime activity | claim | – | grouped | – | none | Inspector |
| Phase marker | claim | – | – | – | none | Inspector |
| Environment | fact | only when it explains a wait | environment line | – | ambient | Inspector, Gateway |
| Policy attribute | fact | – | badge | – | none | audit (call), connection |
| Thread event | fact | shown | shown | – | none | – |
| Held message (after v0.1.0) | human | shown | shown | never | none | – |
| Digest line | fact | shown | shown | – | none | its entry |

Rules that keep the registry safe:

- **Completeness.** The registry MUST be exhaustive over entry kinds at compile time, and a unit test over the protocol's Item type list MUST fail if any kind lacks a row. A new kind cannot ship unrendered or unclassified.
- **Lens invariant as a property test.** Over generated entries, every human, decision and output row, every run outcome and every error or unknown renders the same in Work and Full, and Full's rendering of any entry contains Work's. Full only adds.
- **Voice safety.** Claim and derived rows can never use the fact voice (U1, U9); a test enforces it.
- **Minimal server mirror.** The server needs one fact from the registry: whether a kind is narrative or step, for entries and statistics. That two-value placement table lives beside the timeline read schema, and Web imports it, so the split has one source. Attention class and error class are already server-owned (G6, G7). Nothing else is mirrored.
- **Closed predicates.** Attention values such as "interrupt if blocking" are a closed set of small predicates, not open logic.

#### Agent Profiles

A profile is a small declarative record per agent kind. A new built-in agent gets a profile, not a screen.

A profile is selected first by the server-authored `Thread.entryPath` (`administration`, `knowledge-manager`), which also selects their command and Tool-set contracts ([Thread Visibility](20260909-thread_visibility_and_sharing.md#owns)). For `conversation` Threads it is then selected by the mode from `conversation.navigation` (chat, task or goal). Only an unrecognized ordinary agent gets `default`. A known protected entry whose data failed to load shows an error state, never `default` with ordinary Send.

| Profile | Header | Opening rule | Interventions | Output renderers | Long-run structure |
| --- | --- | --- | --- | --- | --- |
| `assistant` | Title | Latest; divider only for unread answers | Send, Stop | Answer with sources; handoff line; generative UI; output card | No |
| `task` | Objective; plan progress across runs; starter; status; outputs; "Part of Goal" | Anchor, then divider, then latest | Send, Steer, Stop, Retry, Redo, Refine, Review | Output card; file changes | Yes |
| `goal` | Board strip: intent, Plan state, cards with linked-Task state, completion | Board, then narrative at divider or latest | Edit intent and cards; Approve Plan; Accept completion; Cancel | Plan versions; handoff lines; completion candidate | Yes |
| `knowledge` | "Workspace knowledge" | Divider or latest | Send, Stop, decide proposals | Knowledge changes with diffs; cited answer | Yes (upkeep) |
| `administration` | Whole-server banner | Latest | Send, Apply (confirmed), Reject | Configuration candidate: before and after, impact, Saved, Reloaded | No |
| `default` (custom agents) | Title and status | Anchor, then divider, then latest | Send, Stop | Output card | Yes |
| `shared-chat` (after v0.1.0) | Audience line | Divider or latest | Ask the Assistant; Stop own request | As `assistant` | No |

Independent of the profile, the Coordinator is never a steer target; steer goes to an exact Task. Linked Task Items never interleave into the Goal's own timeline. The Goal screen puts the board strip above the Needs-you bar and the Coordinator narrative.

#### Lens Policies

A lens policy maps a registry row and its context to a disclosure. `work` and `full` read the row's two disclosure columns. A run expanded in Work uses `full` for that run only. The phone uses the same policies with a different layout. Another view, such as "decisions only", would be one more policy.

The registry is plain data plus about ten components. It deliberately has no plugin system, no renderers loaded at runtime, no new protocol objects and no server-side rendering decisions.

### Agent Reporting Rules

1. **Outcome first.** The final message opens with the outcome (done, partly done or not done), then what was checked, and how, against the acceptance criteria, then what is left or uncertain. Plain words, no identifiers.
2. **Short progress notes at milestones.** When a plan step starts or finishes, otherwise about every 15 minutes.
3. **A current plan for non-trivial work.** Three to seven steps, with states updated.
4. **Plain questions.** Say why the answer matters, give the options, and say what happens meanwhile.
5. **Never claim a check you did not run.** Write "not checked".

Rule 1 removes the risk that a final message reads only "Done.". Rules 2 and 3 feed the notes, segments, Now, the header and fine-grained anchors. Approval cards are written by the system, so no rule covers them.

- **Built-in agents.** One shared constant is appended to the fixed built-in prompts, within the test-enforced cap recorded in [Centralized Bounded Built-in Prompts](../decisions/20260924-centralized_bounded_builtin_prompts.md) and owned by [Internal Agent Runtime](20260813-internal_agent_runtime.md). The constant fits in about 180 code points or is tailored per role. The Goal Coordinator prompt is trimmed first; its cap is raised only if trimming fails. The Personal Assistant takes rules 1, 4 and 5; the Knowledge Manager takes rules 1 and 5.
- **Workers.** One fixed, versioned reporting text is delivered in the existing exact `instructions.md` of the [Worker Context Package](20260703-worker_context_package.md) and recorded by its separate text digest in the manifest and joined logical trace. Retained instructions and packages keep their original text or absence. The Task Mode service delivers it with the structured delegation request. User Skills and AGENTS files still govern style.
- **Compliance** is measured by evaluation, per adapter and model, not enforced. The timeline still renders agents that ignore the rules.

### Object References And Resolver

Everything the timeline mentions is an `ObjectRef`, and one Web module resolves it:

```ts
type ObjectRef =
  | { kind: 'thread'; workspaceId; threadId; turnId?; itemId? }
  | { kind: 'artifact'; workspaceId; artifactId; version }   // always the exact version
  | { kind: 'audit'; workspaceId; scope: { turnId } | { capabilityCallId } | { itemId } }
  | { kind: 'attention'; workspaceId; rowId; source }          // existing row id and typed source
  | { kind: 'knowledge'; workspaceId; pageId; revision? }
  | { kind: 'material'; workspaceId; threadId; materialId }
  | { kind: 'connection'; workspaceId; connectionRef }          // the fix for "Connect GitHub"
  | { kind: 'gateway'; logicalModelId? }
  | { kind: 'environment'; workspaceId; turnId }               // Inspector section in v0.1.0
  | { kind: 'goal-card'; workspaceId; threadId; cardId };
resolve(ref) → { path, search, focus } | { unavailable: reason }
```

- **Table-driven.** Like the registry, `resolve` is a table. Thread links use the activity route from `conversation.navigation`.
- **Degrade honestly.** A missing anchor degrades to the surface without it, and the link says so: "Opens Usage & audit (not filtered)". An unavailable surface renders as plain text, never a dead link.
- **Audience first.** Before showing a title, the resolver checks the target's audience ([Admission, read and publication](20260909-thread_visibility_and_sharing.md#admission-read-and-publication)). A source the viewer cannot open shows "Source not available to you", with no title or content.
- **Versions are never substituted.** Output references are pinned to the Item's Artifact version, and the link opens that exact version through `artifact.version-read`. If it cannot, it says "Version 3 unavailable" and offers a separately labeled "Open the output's version list".
- **Attention rows resolve by their own source.** An Artifact Review is its review and exact version; Workspace reviews and recovery have no required Thread. The resolver uses the row's timeline anchor when present and otherwise its owning surface (Artifact review, Workspace changes, Recovery, Knowledge). The bar and toasts use the same fallback.

Anchors each reference kind needs:

| Ref | Anchor needed | Tier |
| --- | --- | --- |
| thread | Run, Item and request anchors (Item and request need TB2) | Minimal (run); Extended (Item, request) |
| artifact | Exact `version` over `artifact.version-read` | Minimal |
| audit | Filter by run, call or Item (G17). Fallback: filter only the loaded page, and say so | Extended |
| attention | Action Center `row` | Extended |
| knowledge | Page and revision (G18) | Extended |
| material | Existing anchor | Minimal |
| connection | Connection anchor | Extended |
| gateway | Logical-model anchor | Extended |
| environment, policy rule | Inspector only in v0.1.0; user surfaces deferred ([#652](https://github.com/lingkaix/openkit/issues/652)) | – |
| goal-card | Card anchor | Minimal (with the Goal timeline) |

### Back-links

Every surface that shows an object which came from, or was used by, a timeline shows **"From: ‹Thread title› · run at 10:02 ›"**. It resolves to the exact anchor after the resolver's audience check; an Artifact from a private Thread stays private through its origin lineage.

| Surface | Data for the back-link | Status |
| --- | --- | --- |
| Output (Artifact) | Artifact origin Thread and Turn | Exists. Run anchor now, Item anchor later |
| Audit and usage rows | Thread, Turn, Item and CapabilityCall identifiers on the record | Exists |
| Action Center row | Its Thread, Turn and Item when present | Exists. Item anchor needs TB2 |
| Knowledge change | The upkeep run that published it | To verify (G18) |
| Workspace Sync Review, recovery | Their raising run | Through the attention row |

"Where did this come from?" is then one click from any output, audit record or knowledge change.

### In-App Notifications

There is one attention source, the attention projection, with three views. External channels (Discord, and email through `notification.send`) are a fourth consumer of the same rows.

| View | Scope | Lifetime | Purpose |
| --- | --- | --- | --- |
| Needs-you bar | This Thread, or this Goal and its Tasks | Until resolved | Act here |
| Action Center | Workspace | Until resolved | Triage everything |
| Toast | Across Threads, current tab | Transient | "Something you care about happened elsewhere" |

A toast is allowed only for these events (P7), in a Thread the viewer is not viewing:

1. A decision the viewer can respond to that is **blocking**: either new and blocking, or an existing request that **became** blocking. Blocking is derived and changes over time ([Blocking And Presentation](20260930-pending_requests.md#blocking-and-presentation)).
2. A **failure or unknown outcome of work the viewer waits on** (a run the viewer started, or a Thread where the viewer sent the latest message) **that already raises an attention row**. Row visibility is not involvement: if authorized records cannot establish the viewer's relationship, the row stays in Action Center without a toast.
3. A **handoff** caused by the viewer's own action.

Failures that raise no attention row, and opted-in completion, require an authorized Turn-outcome source and are deferred to a Thread event stream ([#644](https://github.com/lingkaix/openkit/issues/644)). No Action Center row is created just to feed a toast. Never toasted: progress, non-blocking requests (they still count in Action Center), info statuses and other people's routine decisions.

**Content.** A verb-first title, the Thread name and the age ("Approve publishing the weekly summary · Weekly notes · now"), and one action that opens the decision sheet or the outcome line through the resolver. A toast MUST NOT offer Approve or Deny; Answer and Review also open the sheet.

- **Visibility.** Toasts show only in the focused, visible tab; the rows themselves are never lost. The toast region does not steal focus, and toasts are announced politely.
- **Limits.** At most 1 visible toast on a phone and 3 on desktop; more collapse into "+2 more · Open Action Center". At most 1 toast per Thread per 2 minutes; a burst merges ("3 decisions need you in Launch notes"). Each object (request, run) is toasted at most once per tab session.
- **Lifetime.** Decision toasts stay until dismissed; nothing that needs the viewer times out (WCAG 2.2.1). Failure toasts close after 8 s, but not while hovered or focused.
- **Dismissal.** Dismissing marks nothing as read or resolved. Needs you and Action Center keep the row.
- **Queueing.** While a decision sheet or dialog is open, new toasts wait.
- **Source.** The client compares successive Workspace attention reads, keyed by row identifier and `blocking`, so both new eligible rows and nonblocking-to-blocking transitions toast. Titles come from that authorized read, and a queued toast is rechecked before it shows (see [Degraded Conditions](#degraded-conditions)). No new server channel is needed in v0.1.0.

### Navigation State

- **URL and history.** The URL holds the surface plus the anchor (`?turn=`, `?item=`, `?row=`). History state holds the scroll position and expanded runs; the lens is a per-device preference. Loaded windows stay cached for 5 minutes, but on every mount, Back included, the bounded dashboard read MUST succeed before cached content shows. Scroll and lens then restore at once.
- **History entries.** Opening another surface **pushes**. Jumps inside the timeline (Needs you, divider, Jump to latest) **replace**, so Back leaves the Thread rather than walking through jumps. Scrolling never rewrites the URL.
- **Phone sheets.** Decision, steps and Inspector sheets are history entries, so system Back closes the top sheet first. Sheets stack at most two deep; a third replaces the second. A deep link to a decision opens the Thread at the request with the sheet on top; Back closes the sheet and shows that place.

### Intervention

| Action | Available when | Consequence shown first | Result shown |
| --- | --- | --- | --- |
| Send | No run in progress | Task: "Starts a new run of this Task." | *Sending*, then the authoritative Item |
| Steer | Task run in progress; the adapter is qualified for `task.steer` | "Sends this note into the run in progress. Accepted means the worker's runtime took it, not that the model acted on it. Work already done is not undone." | *Sending*, then *Accepted by the running worker* / *Not delivered* (with reason) / *Delivery unknown*, from the retained receipt |
| Keep draft | Run in progress, steer unavailable | "This Task is busy. Your message stays here. Send it when the run ends, or stop the run first." | Draft kept |
| Stop | Run pending or running | "Stop this run? Finished steps and their effects stay. The step in progress is cut short." | *Stopping…* until the terminal status, then "Stopped by you" from the recorded interrupt |
| Approve | Pending; the viewer may respond; the complete exact effect is displayed | Exact effect; whether work waits. Per owner: captured call, "Lets this call run once."; command intent, "Allows ‹owner› to ‹intent›. It runs later, through its owner." | "Approved by you", then the recorded disposition (executed, failed, outcome unknown) and delivery, each only when recorded |
| Deny | Pending; the viewer may respond. Available even when the exact effect is unavailable | "The call does not run." | "Denied by you" |
| Withdraw | The viewer is the responsible user | "The request closes without a decision." | Closed |
| Answer | Pending, not secret | "The agent receives your answer on its next run." | "You answered" |
| Accept or Request changes | Review pending | "Accept marks this version as the result." / "Starts a follow-up run with this version as context." | Review state |
| Redo, Refine, Retry | The owner offers it | "Starts a new run. This one stays in history." | New run |
| Edit Goal intent or card | Goal open | "This does not change running Tasks. The Coordinator reads it the next time it plans." | New revision |
| Approve Plan version | Pending | What changed; "Allows the Coordinator to start Tasks inside this plan without asking for each one." | Activated when consumed |
| Accept Goal completion | Pending | "Accepts this completion. The Goal then closes, and no new Tasks start." | "Accepted by you"; "Goal closed" only from the Goal owner |
| Cancel Goal | Goal open | "Stops new work and asks running Tasks to stop. History stays." | Cancelled |

**Exact effect gate.** Approve is enabled only after the complete exact effect is shown in the card or sheet, read from the existing exact-detail owner ([Exact Effect Disclosure](20260930-pending_requests.md#exact-effect-disclosure)), not from the bounded Item preview. If the detail is unavailable or truncated, the card says "Exact effect unavailable; approval disabled" and keeps Deny and Withdraw ([Human Attention](20260531-human_attention_intervention_model.md)).

#### Steer

`task.steer` is specified by [Task Mode](20260704-task_mode_worker_delegation.md#live-steer) and the [Task Live-Steer Rulings](../decisions/20261008-task_live_steer_rulings.md); the Composer owns the submission ([Explicit Live Input](20260831-unified_conversation_composer.md#explicit-live-input)).

- **Rollout and fallback.** Steer is enabled per adapter, in the order Codex, Pi, OpenCode, each only after its qualification passes (races, interrupt, stale target and no spill into later runs). DeepSeek is unsupported. Workers on other adapters show "This worker can't take notes while running", with *Keep draft* and *Stop*.
- **State survives reload.** The steer state is not mutation-local. The timeline read joins each steer `user-message` Item to its retained command receipt, so reload and other devices show the same state. An Item without a provable receipt shows *Delivery unknown*. Check and Retry reuse the exact target, text and request identifier. No receipt mechanism is added.

#### Core-Held Follow-up (After v0.1.0)

This behavior is deferred to the first item after v0.1.0 ([#643](https://github.com/lingkaix/openkit/issues/643)) and is recorded here so the timeline reserves its rendering.

Delivery today is optimistic: Send when the Thread is idle, Steer while a run is in progress. Ordinary input to a busy Thread is refused with `thread_busy`, and the timeline keeps the draft.

1. The person sends while a run is in progress.
2. NanoCore records the message as held for this Thread, under the message's request identifier.
3. When the current run ends, NanoCore hands the message to the agent through the ordinary Send path, which starts the next run.

A held message renders in place after the running run, in the human voice, with the state *Waiting for this run to end*. Edit and Cancel work until delivery starts; both are ordinary commands with request identifiers. On delivery it becomes an ordinary user message of the next run. If the run ends failed, stopped or waiting for a decision, the message stays held and says why: "Not sent: the run stopped. Send now · Edit · Cancel".

Core holds and delivers the message and the client only shows Core's state, so the rule that clients must not invent queueing or follow-ups ([Active-Turn Input Projection](../core/communication.md#active-turn-input-projection)) holds. The [Delivery Policies](20260531-human_attention_intervention_model.md#delivery-policies) items are: owner, the Thread's input path in NanoCore; durable proof, the held record exists before the request returns; failure, the message stays held with a reason; restart, it survives and is delivered once the run is terminal; replay, the request identifier returns the original outcome. One held message per Thread is the initial scope. Where steer is supported both are offered; where it is not, the held message is the natural fallback, and *Keep draft* remains.

#### Other Rules

- **No client queue.** The Web never holds, delays or replays input on its own.
- **Take over** is composed from three steps: Stop; edit the output, which creates a new version; then Refine or start a new run. A single action is deferred ([#651](https://github.com/lingkaix/openkit/issues/651)).
- **Task plans are snapshots.** Direction changes by steering or sending a message.
- **Confirmations.** Only Stop and Cancel Goal ask for confirmation. An approval card is its own confirmation.
- **Request identifiers.** Every command carries a request identifier, and a retry reuses it. If someone else decided first, the card shows who won.

### UI And Interaction Rules

These rules turn the principles into visible detail. They reuse the Web visual language: the semantic design tokens and three themes; type roles of 24, 18, 16 and 14 px plus 14 px code; a 4 px unit; 44 px targets; an attention mark of at least 8 px paired with a word; the `EmptyState`, `Skeleton`, `ErrorBanner` and `Toast` primitives; one icon per row. New tokens are `--ok-voice-fact` (left rule for recorded facts), `--ok-voice-generated` (dotted border) and `--ok-measure-prose: 72ch`. Each rule names its check.

| # | Rule | Check |
| --- | --- | --- |
| U1 | **Provenance voices** (P3, P4). *Human:* avatar with initials, 16 px on a raised surface. *Agent claim:* agent mark, 16 px, no fill. *Recorded fact:* no avatar, 14 px, tabular numbers, fact icon, `--ok-voice-fact` left rule. *Generated:* "Generated" chip, dotted left border. Deterministic counts (summary line, digest) are facts, labeled "counted from records" | Every entry carries `data-voice`. A unit test maps registry category to voice. Screenshot review in all three themes |
| U2 | **Emphasis budget.** Accent only for "needs you" markers and a decision's primary button; red only for a problem with an action; unknown is amber with "?"; everything else neutral. At most **3** emphasized elements per viewport, bars included; extra rows fold into the bar count. Status is always icon plus text | Playwright counts `[data-emphasis]` in the viewport on fixtures (≤ 3). The Web package's raw-color rule. axe contrast check |
| U3 | **Type and density.** Messages and notes 16 px, line height 1.5, ≤ 72ch. Outcome line 16 px medium with icon. Trigger and summary lines 14 px secondary, tabular numbers. Steps 14 px, code 14 px mono. Work: 24 px between runs, 8 px within. Full: 28–32 px step lines on desktop with a 44 px expand control; 44 px rows on phones | Component tests on computed font size, line height and max width. Playwright: no horizontal page scroll at 360 px |
| U4 | **Motion with meaning.** A slow pulse (1.5 s) on the Now dot only while events arrived in the last 10 s. A new decision gets one 200 ms fade-in of the bar. No per-token, looping or shaking animation; routine updates have no motion. Reduced motion: no pulse, no slide, instant jumps | Playwright: `document.getAnimations()` is empty when idle, and empty under emulated reduced motion |
| U5 | **Time.** Relative within 24 h, absolute beyond (and on hover or long press). Durations on runs and on steps of 1 s or more; decisions show their age; staleness as "Updated 2 min ago". Refresh at most every 30 s, except Now's elapsed time. Server time with clock-offset correction | Every time is a `<time datetime>` element. Unit tests at the formatting boundaries |
| U6 | **Consequence micro-interactions.** Committing actions (Steer, Stop, Approve, Deny, Apply, Accept completion, Cancel Goal) show consequence text next to the control, not in a tooltip. While pending: "Approving…", siblings disabled with a reason; no silently disabled control. Undo only where truly reversible (discarding a draft for 10 s, lens, folds); Goal edits offer "Revert" as a new revision. Afterwards, the recorded result with actor and time | The shared `Button` primitive stays unchanged. Component tests on the timeline's action controls: consequence text is visible and is the accessible description; every disabled control exposes its reason |
| U7 | **Folds.** "▸ 37 steps · 2 failed": chevron, count, kind, failures. Expanding keeps the control in place; collapsing brings it back into view. At most two levels (run, group); larger bodies open in the Inspector or a sheet. Expansion persists per run in history state | Playwright: the control's top moves by ≤ 2 px when expanded. DOM: fold depth ≤ 2 |
| U8 | **Empty, loading and error states that teach.** Skeletons shaped like run entries, no spinners; reserved heights for the bars. Empty copy says what will appear and why ("This Task hasn't started yet. Its first run will appear here with its plan and progress."). Each region fails on its own, with Retry | Playwright cumulative layout shift ≤ 0.05 over the first load plus 30 s of a streaming fixture. Component tests on the empty-state copy |
| U9 | **Trust cues.** "Used N sources" with links. Worker-reported data labeled "reported by the worker". The complete exact effect before Approve enables. The summary line next to the claim (P4). Model-written text is never shown in the fact voice | The registry voice test. Approval-card tests: Approve disabled while detail is missing or truncated; Deny still available |
| U10 | **Phone.** Primary actions in the bottom 40% (decision buttons, composer with Stop and Steer). Decision sheet full height; steps and Inspector sheets open at 60%, expandable; each has a handle and a 44 px close button. Voice steer uses the existing voice input with an editable transcript. Nothing depends on hover | Playwright at 360×740: the primary action's top is at ≥ 60% of viewport height, and targets are ≥ 44 px |
| U11 | **Plain language.** No identifiers, digests or enum values in Work, Now, Needs you or outcome lines. No internal words (Turn, Item, AgentSession, Harness, AEP, Provider route, CapabilityCall, Shard, Policy revision); "run" is the word for a Turn, and Full may name models. Verb-first, naming the actor. Unknown is never called failed. Errors say what happened, what it means and what you can do | A lint over the copy module (banned words, identifier patterns). A Playwright scan of the DOM text on Work-lens fixtures |
| U12 | **Accessibility.** `role="feed"` of `article` elements, `aria-busy` while loading. Load earlier and later are buttons; focus is kept after loading. Needs you is a named region; jumping to it moves focus. Announcements only for new decisions, the end of a watched run, and send or steer outcomes; streamed text once, when complete. Never color alone. Keyboard shortcuts are deferred ([#650](https://github.com/lingkaix/openkit/issues/650)) | axe-core: no serious violations on fixtures. Keyboard-only Playwright path through S1 and S2 |

### Loading And Performance

**Two-level windows.**

- **Level 1, run entries:** header, a bounded narrative window with counts and a continuation, latest plan, latest 3 notes, step statistics and, in the Extended tier, per-segment counts; no steps. Fetched around an anchor, or before or after an opaque cursor.
- **Level 2, Items inside one run:** pages of 50 narrative Items or steps, anchorable at an Item and paged both ways (catch-up anchor, deep links, mid-run requests). Over 500 steps, the entry offers "Open all steps" in a sheet.
- **Anchors:** latest, run, Item, attention row and catch-up anchor B. An Item anchor returns its entry plus a Level-2 window around the Item.
- **Bodies:** previews of at most 4 KB; the full body by lineage (Workspace, Thread, Turn, Item), rejecting an Item outside that lineage. Byte-range reads are deferred ([#645](https://github.com/lingkaix/openkit/issues/645)).
- **Authorization per source.** The window read and the dashboard MUST apply each joined owner's authorization and redaction before building the response. Matching `thread.items` access is necessary, not sufficient. A field the viewer may not read shows "restricted", with no count, label or metadata derived from it.
- **Bounded live delivery.** For process Items over the preview bound, the event stream sends the bounded preview and a body reference; the full body stays with its owner and is fetched only through the body read. Web keeps only a bounded tail of streamed output.

**Opening, scrolling, following and rendering.**

- **Opening:** anchor, then divider, then end. The first window holds 20 entries before the anchor and up to 10 after.
- **Paging:** sentinels 1.5 viewports from each edge; visible Load earlier and Load later buttons remain; far anchors get "Jump to latest".
- **Scroll anchoring:** prepends keep the first visible entry in place (measure, then correct in the same frame). `overflow-anchor` is used where supported, and the manual correction always runs, because not every engine supports it. Growth above the viewport never moves the reader.
- **Follow mode:** on within 48 px of the end. Scrolling up turns it off and shows "↓ N new", with the accent for a decision.
- **Rendering:** no virtualization library in v0.1.0; paging and collapsed steps keep the DOM small, and page eviction is deferred until measurement requires it ([#645](https://github.com/lingkaix/openkit/issues/645)). Text deltas coalesce per animation frame (≤ 10 renders per second); Now updates at most twice a second. Steps render once per frame and only while visible; heavy rendering waits until an Item completes. The composer is isolated from stream renders. Hidden tabs render nothing; after 2 minutes hidden the stream closes and the client resyncs from its cursor.

**Budgets.** Calibrate on a fixture with 5,000 runs plus one run of 10,000 Items.

| Budget | Target |
| --- | --- |
| Open to bars plus first window | p75 ≤ 1.0 s desktop; ≤ 2.0 s on a mid-range phone over 4G |
| Window read, server | p95 ≤ 150 ms, independent of history (requires TB1) |
| Window payload | ≤ 256 KB; previews ≤ 4 KB |
| Dashboard | ≤ 32 KB; cost independent of history |
| Timeline DOM | ≤ 3,000 nodes at default |
| Streaming | ≤ 10 renders per second; composer keystroke p95 < 50 ms |
| Polling | Idle ≤ 1 per 15 s; running ≤ 1 per 5 s plus the stream; hidden: none |
| Layout shift | Cumulative ≤ 0.05 (U8) |

**Media.** Images are lazy thumbnails in reserved boxes. Files are chips. Outputs over 1 MB never render inline.

### Degraded Conditions

**Freshness and admission.**

- After 3 missed refreshes a surface shows "Updated 2 min ago". Controls that depend on state (approve, answer, steer) are disabled with a reason while that state is stale or unknown.
- A cache never authorizes ([Admission, read and publication](20260909-thread_visibility_and_sharing.md#admission-read-and-publication)). A stale view is kept only within a mount whose admission read succeeded. A denied read hides cached content, derived labels and queued toasts at once. Account changes clear caches and the toast queue and discard earlier-account responses ([Deployment Configuration Projection](20260628-web_product_surface_projection.md#deployment-configuration-projection)). Hiding content never drops a pending or unknown command's request identifier.
- **Administration exception** ([Private Administration Candidate Projection](20260628-web_product_surface_projection.md#private-administration-candidate-projection)). Admission at mount is not enough. A failed Items or candidate read, or a failed retry, hides private candidate facts and dialog content at once, not only on 401 or 403. Effects, including confirmation in an already open dialog, are blocked while a required read is pending, paused or failed. Facts return only after successful current source reads. Dispatched commands, the exact candidate identity and unknown-result locks are kept.

| State | Shown | Still works |
| --- | --- | --- |
| Reconnecting | "Live updates paused · reconnecting" | Everything; polling covers |
| Offline | "Offline. You are seeing what loaded at 10:42. Sending is paused." | Reading what this mount already admitted; drafts |
| Server busy (429/503) | "OpenKit is busy. Retrying in 20 s." The last admitted view stays, marked stale | Reading |
| Out of date (stream validation failure) | "This page is out of date. Reload to continue." Drafts kept | Reading |

**Reconnect.** Paging cursors and event sequences are different things. Items change in place (text, output, snapshot and progress updates), so fetching after a paging cursor cannot recover a lost update.

- Backoff with jitter: 1, 2, 4 … 30 s, honoring `Retry-After`.
- The running Turn's stream resumes from its last validated event sequence.
- On `core.stream.cursor_expired`, after a polling fallback, or when the dashboard shows a Turn that started while disconnected, the client authoritatively rereads every open (non-terminal) entry and every entry whose Turn changed. Completed snapshots replace what the client holds.

**Sending.**

- *Sending* is styled distinctly and never looks sent.
- *Not sent* gives the reason and keeps the draft, with Retry (same request identifier) or Edit.
- *Unknown* says "We couldn't confirm OpenKit received this. Check." Check replays the same request identifier, and idempotency returns the original outcome.
- The client never mints a new request identifier on its own.

| Error class | Example | Shown | Actions |
| --- | --- | --- | --- |
| Work problem | Tests failed | "Stopped: tests failed in export_test", plus the final message | The owner's actions (Retry, Refine), Full |
| System problem | Provider down; Sandbox failed | "OpenKit couldn't finish this: the model provider is unavailable." Steps and effects already recorded stay visible | The owner's actions. Administrators get a link to Operations |
| Needs you | Missing connection; policy block | "Connect GitHub to continue" | The fix surface, through the resolver |
| Unknown outcome | Effect not confirmable | "We can't confirm whether the email was sent. Check before retrying." | Inspect; no automatic retry |

- The class comes from the server, as a stable code mapped to a class plus the actions its owner offers (G7).
- **Error origin is not effect certainty.** A provider can fail after earlier commands or external effects succeeded ([Conflict, Failure, And Recovery](../core/communication.md#conflict-failure-and-recovery), [Work Model](../core/work-model.md)). "Nothing was changed" appears only when the owning operation proves no effect, for example a refusal before admission.
- Unmapped codes get neutral text ("This run ended with an error") and only the actions the owner returned. They never imply that nothing changed or that a retry is safe.
- Each region fails on its own. A failed read never renders as empty.

### Phone

- One sticky bar merges Now and Needs you: "● Running 12 min · 1 needs you ›". The header line truncates to "3/5 · Update tests".
- Decisions open in full-screen sheets, directly from toasts and notifications.
- Steps and the Inspector open in sheets. The environment line lives in the Inspector sheet. Full starts off.
- The composer docks above the safe area, offering Steer or Stop. Voice is the natural input for steering.
- The stream closes in the background and resyncs on focus.
- No swipe gestures for decisions. Long press shows the absolute time.
- Only the app shell works offline. No authenticated data is cached.

```text
┌────────────────────────────────┐      ┌────────────────────────────────┐
│ ‹ Fix the CSV export       ⋯   │      │ ‹ Decision                     │
│ 3/5 · Update tests             │      │ Publish the weekly summary?    │
│ ● Running cmd 4 min · 1 needs ›│      │ Worker · "Weekly notes" · 2 h  │
├────────────────────────────────┤      │ Work continues meanwhile       │
│ Worker · running 3 h · 1,240 › │      │ Exact effect (in full):        │
│ ✓ Reproduce  ✓ Fix  ● Tests    │      │ slack.post_message             │
│ ── New since 12:40 ─────────── │      │ { "channel": "#team", … }      │
│ 13:05 Leap-day fixtures fixed; │      │ Approve: lets it post once.    │
│ 6 of 7 pass.                   │      │ Deny: nothing is posted.       │
│ ● Question: date format? ›     │      │ [   Deny   ]   [  Approve  ]   │
├────────────────────────────────┤      │ Next decision (2 more) ›       │
│ [ Message the worker …   🎤 ]  │      └────────────────────────────────┘
│ [Stop]                 [Steer] │
└────────────────────────────────┘
```

## Proposed Design

### Read-Model Needs

| Id | Need | Slice |
| --- | --- | --- |
| G1 | A Thread-scoped read path: list one Thread's Turns without reading the rest of the Workspace | TB1 |
| G2 | `thread.items` is forward-offset only, with no newest-first order, anchor or filter; Web must stop reading it unbounded | TB2, TW0 |
| G3 | A run-entry window and an Item-anchored Level-2 window: a new `thread.timeline` read, one snapshot per call, carrying the shared placement table | TB2 |
| G4 | Bounded bodies in reads and in live events: previews, size, a truncation flag, a body read by lineage and bounded live events | TB2 (previews), TB3 |
| G5 | A bounded dashboard: no embedded Items; Now fields (open step's kind, title and start; last event time; queue position; whether steps are reported live); the latest plan across runs | TB4 |
| G6 | Thread and Goal scope for attention rows; the dashboard carries more than approvals and questions. `blocking`, `ageSeconds` and `turnsSince` are reused | TB4: approvals, questions, Artifact Review (Minimal); all eight kinds (Extended) |
| G7 | A Turn error carries a class and the owner's actions, not only a code and message | TB5 |
| G8 | The catch-up anchor B and the digest | TB2 (anchor, Minimal); TB4 (digest, Extended) |
| G9 | Admission-order run ordering | TB2 (read model); storage key with TB1 |
| G10 | The `task.steer` operation and per-adapter mapping | TB6 |
| G11 | A bounded per-run environment view from observations | TB4: last observation and model (Minimal); usage and fallback (Extended) |
| G12 | Permission outcome and connection on steps, from the exact PermissionDecision and Pending Request lineage; no new record | TB7 (Extended) |
| G13 | A Thread-level event stream so other Threads' outcomes and completions can toast | Deferred, [#644](https://github.com/lingkaix/openkit/issues/644) |
| G14 | A seen-through marker | Deferred, [#649](https://github.com/lingkaix/openkit/issues/649) |
| G15 | Decision Trace links | Deferred, [#278](https://github.com/lingkaix/openkit/issues/278) |
| G16 | Reporting guidance reaching Workers and built-in agents | TB-R |
| G17 | Audit and usage lists filtered by run, call or Item, although records carry those identifiers | TB7 (Extended); fallback is a loaded-page filter |
| G18 | Knowledge page and revision anchors, and the back-link from a knowledge change to its run | Verify; Extended |
| G19 | User surfaces for a run's Sandbox environment and for policy rules | Deferred, [#652](https://github.com/lingkaix/openkit/issues/652); Inspector meanwhile |

Web-only needs: project the dashboard's existing work status; add the Coordinator narrative to the Goal screen; replace the whole-Thread Details list; add the Web anchors listed under Object References And Resolver.

These needs add no durable records or owners. They reuse attention `blocking`, `Thread.entryPath`, `artifact.version-read`, steer receipts, the `turn.interrupt` audit actor, and PermissionDecision and Pending Request lineage. G1 adds derived storage structures. The reporting text is fixed product text with a digest. Everything else is a read model, and no view becomes an authority.

## Current Implementation Projection

Implementation is In Progress. Bounded server and Web timeline slices have landed, including several Extended reads. One landed slice is not completion of this specification. The notes below name what is current and what stays open.

- **History reads.** `thread.timeline` and `thread.items` use bounded pages. Web earlier pages continue from the returned cursor (`apps/web/src/screens/chat/data.ts`). Pending-Turn polling is separate from an idle Thread. The server read is `apps/nanocore/src/thread-timeline.ts`.
- **Dashboard.** `thread.dashboard` returns one active or latest run header and no Items. Indexed Now and latest-plan fields stay with that bounded read. The storage guide records the covering indexes.
- **Events.** Ordinary SSE replaces an Item payload above the preview bound with `item-preview` and a body selector. Turn update and terminal events carry headers and empty Items. Clients request a complete body through `thread.item-body`.
- **Rendering.** The timeline registry, lenses, run windows and resolver live under `apps/web/src/screens/chat/timeline/`. Remaining presentation polish is open. This is not an absence of the timeline surface.
- **Registry projection.** The protocol has 17 Item types (`ItemTypeSchema` in `packages/protocol/src/models/item.ts`). The registry is declared `satisfies Record<EntryKind, RegistryRow>`, and the completeness test iterates `ItemTypeSchema.options`. The placement table lives in `packages/app-api-schemas` next to the timeline read schema. `Thread.entryPath` is in `packages/protocol/src/models/thread.ts`.
- **Attention.** Rows with `blocking`, `ageSeconds` and `turnsSince`, and the Workspace review and recovery rows without a required Thread, are in `packages/app-api-schemas/src/action-center.ts`; runtime attention rows are raised in `apps/nanocore/src/action-center.ts`. `attention.list` accepts only a Workspace (`attention-operations.ts`). The existing handoff toast is in `apps/web/src/screens/chat/data.ts`.
- **Environment and policy sources.** `usage.read`, `audit.workspace-list` and `audit.server-list` accept intersecting `turnId`, `capabilityCallId` and `itemId` selectors. Filtering precedes pagination, and a continuation keeps the original selectors. Runtime activity on the bounded dashboard remains a separate, narrower read.
- **Artifacts and errors.** `artifact.version-read` is in `packages/app-api-schemas/src/artifact-operations.ts`; Artifact origin fields are in `packages/protocol/src/models/artifact.ts`. A Turn `error` is `{code, message}` (`packages/protocol/src/models/turn.ts`).
- **Steer.** `task.steer`, its receipt and the qualified-availability source exist. Adapter and runtime qualification are separate. That is not acceptance of every adapter. Codex, Pi, OpenCode and DeepSeek still need their own delivery proof.
- **Reporting rules.** New Task requests carry fixed `reporting-v1` text. The package manifest and trace digest are checked separately. Sampling proof remains separate.
- **Web primitives.** Semantic tokens are in `apps/web/src/styles/tokens.css`; the visual language is projected in `DESIGN.md`. Toasts use React Aria's `UNSTABLE_ToastQueue` (`apps/web/src/primitives/Toast.tsx`). The raw-color rule is in `apps/web/AGENTS.md`.

| Ref | Route today | Anchor today |
| --- | --- | --- |
| thread | `/chat`, `/tasks` or `/goals` + `/:workspaceId/:threadId` | `turn`, `turnId`, `item` and `request` in `apps/web/src/screens/chat/timeline/resolve.ts` |
| artifact | `/artifacts?workspaceId=&artifact=`; Goal review `/goals/:ws/:thread/artifacts/:id` | exact `version` when the address has one |
| audit | `/workspace/usage`; `/settings/server-audit` | None |
| attention | `/attention` (Action Center); owning review or recovery surface | None |
| knowledge | `/knowledge` | Not verified |
| material | `/materials/:ws/:thread/:materialId?` | Yes |
| connection | `/workspace/vault` | None |
| gateway | `/settings/gateway` | None |
| goal-card | Goal route | None |

Audit, attention, knowledge, connection, gateway and goal-card anchors in this table remain unresolved. Thread and Artifact addresses above do not close those gaps.

## Alternatives Considered

- **Two interfaces, work and technical.** Rejected: the same person needs both depths within minutes, two interfaces double the build and test cost and drift apart, and truth must not depend on the version. One switch over one registry keeps the lens invariant testable.
- **A screen per agent kind.** Rejected: new kinds would fall through silently, the lens invariant would be testable only by screenshots, and the Goal and Administration screens would keep diverging. Declarative profiles over one registry replace it.
- **A renderer plugin system, renderers loaded at runtime, new protocol objects or server-side rendering decisions.** Rejected as unnecessary for a closed set of first-party kinds.
- **Audit rows in the narrative.** Rejected: audit stays behind the Inspector link.
- **A client-side queue.** Rejected: clients must not invent delivery. The Core-held follow-up is not a client queue.
- **Automatic contradiction detection.** Rejected: the summary line beside the claim makes a contradiction visible; the person judges it.
- **Generated catch-up prose in v0.1.0.** Rejected for v0.1.0: it costs tokens, can misstate work and needs an owner. A deterministic server digest replaces it.
- **A client-computed digest.** Rejected: the client cannot count without loading everything, and phone and desktop must agree.
- **A virtualization library in v0.1.0.** Rejected until measurement requires it; paging and collapsed steps bound the DOM.
- **Also rejected:** swipe decisions; reactions; a new waiting status; role-based defaults; badges on in-Sandbox steps; one-tap approval from a toast; auto-dismissing decision toasts.

## Consequences

- The whole-Thread Details list is removed, and its landed tests migrate to run-entry tests.
- Per-kind rendering moves into one registry. A new Item type fails compilation and the completeness test until it is classified.
- New bounded reads replace whole-history reads. The server-time budget is met only after TB1; until then, paging meets the payload budget but not the server-time budget.
- G1, G3 and G5 change storage reads under concurrency and need a load measurement before they land.
- Bounded live events change what the stream sends for large process Items; the exact projection is reviewed with TB3.
- No durable record or owner is added; every fact keeps its owner's access rule.

## Rollout / Migration Plan

**v0.1.0 scope.** Both tiers below are in v0.1.0 and are delivered in slice order.

| Tier | Contents |
| --- | --- |
| Minimal | **Web:** TW0 idle fix; registry, profiles and lens policies; run entries with Work \| Full; long-run plan and notes; Needs you; Now; alignment header; divider and jump; paging and follow mode; send and error states; Goal timeline; phone bar and decision sheet; resolver with today's routes; back-links where the data exists; exact output versions; audience checks on every title and back-link; the toast policy for blocking decisions and attention-backed failures; navigation restore after admission; U1–U3, U5–U8 and U10–U12. **Backend:** window read with Item anchors and step windows; bounded previews, a body read by lineage and bounded live events; per-source authorization; bounded dashboard with Now fields, latest plan, last environment observation and model; error classes; steer receipts in the read; reporting rules |
| Extended | Catch-up digest; plan segments with counts; policy badges; usage and fallback on the environment line; all eight attention kinds; audit filters by run or call; anchors for Action Center rows, knowledge pages and connections; compression R3; motion polish (U4) |
| Depends on the storage owner | Thread-scoped storage index and ordering (TB1) |

**Order and dependencies.**

- TW0 lands first. TW1–TW3 and TW5–TW8 build on today's data behind `TimelineSource`.
- TB2–TB5 and TB-R follow, then TB6. TB7 is Extended.
- TB1 is delivered by the storage owner's Thread-scoped read path, not as a separate timeline slice.
- TW4 needs TB2; TW9 needs TB4; TW10 needs TB6.
- After the core Web slices land, a dedicated UI and UX polish pass reviews the key parts and details.

**Backend slices.**

| Slice | Scope | Done |
| --- | --- | --- |
| TB1 (G1, G9) | List one Thread's Turns without reading others; durable admission-order key; Item lookup by identifier within its Thread; cheap per-Turn step counts | On 200 Threads × 250 Turns, listing one Thread is no slower when the others grow tenfold |
| TB2 | Timeline window read (G2, G3, G4 previews, G8 anchor, placement table, steer receipts) | Every anchor works, including an Item inside a running Turn; cursors are stable under concurrent appends; entries carry a bounded narrative window, plan, notes and statistics; one Turn with 2,000 messages stays ≤ 256 KB; each joined source keeps its own authorization (tests: Thread access without `audit.read`; a private source referenced from shared work); steer Items carry their receipt state |
| TB3 | Body read by lineage (G4), bounded live projection | A 5 MB output is retrievable; previews equal its head or tail; a cross-Thread Item identifier is rejected; a 5 MB live command output never reaches the browser whole |
| TB4 | Bounded dashboard (G5; G6 scope; G8; G11 minimal) | Cost independent of history and other Threads; ≤ 32 KB; Now fields and latest plan correct; attention rows, including `blocking`, equal Action Center's; last environment observation with its age and the model, when recorded |
| TB5 | Error class (G7) | Every Turn error code maps to one class with its owner's actions; unmapped codes get neutral text and no invented actions |
| TB-R | Reporting rules (G16): shared constant, Worker text, owning specification edits, Goal Coordinator prompt trimming | The prompt cap test passes; the package trace records the digest; 20 sampled runs per qualified adapter open with the outcome |
| TB6 | `task.steer` (G10) | The Task Mode acceptance table passes, then qualification in the order Codex, Pi, OpenCode |
| TB7 (Extended) | Policy attributes (G12), segment counts, audit filters (G17) | A badge appears only with its full lineage: a waiting approval never shows as denied; missing linkage shows no badge; in-Sandbox steps show none; "Audit records for this run" opens filtered |

**Web slices.**

| Slice | Scope | Done |
| --- | --- | --- |
| TW0 | While every Turn is terminal, drop the 5 s `thread.items` refetch and invalidate only on a dashboard signature change (latest Turn identifier, status, newest Turn's Item count). While a Turn is open, keep today's refetch | Zero `thread.items` requests over 5 idle minutes; a run started elsewhere appears within one interval |
| TW1 | Registry, profiles, lens policies, copy module; route today's rendering through them (visible change: plain language only) | The completeness test fails on a missing kind; the lens property test and copy lint pass; Administration and Knowledge Manager select their profile from `entryPath` |
| TW2 | Run entries, Work \| Full, long-run plan and notes, minimal Inspector, U1/U3/U7/U9; remove the whole-Thread Details list | The long-run fixture shows the plan plus 3 notes; identifiers only in the Inspector; U1, U7 and U11 checks pass |
| TW3 | Needs you, Now, alignment header, U2/U4/U5 | Blocking first, and the jump focuses the card; every Now state, including a 40-minute command that never shows Quiet; a stale plan is labeled; emphasis ≤ 3 |
| TW4 | Paging and scrolling (needs TB2) | Every anchor works; a prepend moves content ≤ 2 px; 100 deltas never move a reader scrolled up; ≤ 3,000 nodes; layout shift ≤ 0.05; composer latency holds |
| TW5 | Degraded and send states, admission gating, reconnect, U6, U8 | Every connection and send state renders; retry never mints a request identifier; a denied read and an account switch hide cached content and toasts; Administration: admission, then a generic source error and a failed retry hide candidate facts and block Apply, also in an open confirmation dialog; a lost update with an unchanged Item count is recovered; consequence text and disabled reasons are accessible descriptions |
| TW6 | Goal timeline through the `goal` profile | No raw identifiers; card to Task and back; Items never interleave |
| TW7 | Phone, U10 | Playwright at 360 px for S1–S3; thumb-zone and sheet-history checks |
| TW8 | Hub: resolver, back-links on outputs and audit or usage rows, toast policy, navigation restore | Every `ObjectRef` resolves or renders as text with a reason; an old output opens its exact version; a private source shows no title; Back restores scroll within 2 px and the lens after the admission read; 5 decisions in one Thread yield 1 merged toast; in a shared Workspace, another member's failed run does not toast an uninvolved viewer; a request that turns blocking toasts once; a dismissed toast leaves its rows; no toast in an unfocused tab |
| TW9 | Divider and digest (needs TB4) | Opening rules hold, including an anchor inside a running run; an unread message before the anchor keeps its mark and the earlier-unread jump |
| TW10 | Steer (needs TB6) | All four outcomes render, also after reload and on another device; Check reuses the exact target, text and request identifier; the draft survives Not delivered and Unknown; unqualified adapters show the reason |

**First item after v0.1.0** ([#643](https://github.com/lingkaix/openkit/issues/643)).

| Slice | Scope | Done |
| --- | --- | --- |
| TB8 | Hold, edit and cancel one message per Thread; delivery through the ordinary Send path when the run is terminal; the Human Attention Delivery Policies amendment naming its five items | A message held during a run starts the next run exactly once, also across a restart; edit and cancel race correctly with delivery; a failed, stopped or needs-you run leaves it held with a reason; a replayed request identifier returns the original outcome |
| TW11 | "Send when this run ends" | The held message renders in place with *Waiting for this run to end*, Edit and Cancel; not-sent states show reasons; the client holds nothing itself |

## Testing Strategy / Acceptance Criteria

- Each slice's Done line is its acceptance criterion. An independent test author writes behavior tests from this specification before reading the implementation.
- **Registry:** compile-time exhaustiveness, the protocol Item type completeness test, the lens-invariant property test and the voice-safety test.
- **UI rules:** each U-rule's check, including the copy lint, emphasis count, fold movement, layout shift, animation idleness, thumb zone and axe-core runs on fixtures.
- **Budgets:** measured on a fixture with 5,000 runs plus one run of 10,000 Items.
- **Authorization:** Thread access without `audit.read`; a private source referenced from shared work; a denied read and an account switch; an Administration source failure after admission.
- **Reconnect:** a lost update with an unchanged Item count, and a Turn that started during the disconnection.
- **Toasts:** merged bursts, blocking transitions, an uninvolved viewer in a shared Workspace, dismissal and unfocused tabs (TW8).
- **Reporting rules:** compliance is measured by evaluation per adapter and model; TB-R samples 20 runs per qualified adapter.

## Risks & Mitigations

- **Unmeasured thresholds.** Budgets, long-run and Quiet thresholds, toast rate limits and the emphasis budget are unmeasured. Calibrate them on the budget fixture and on real runs before treating them as final.
- **Prompt sizes are rough.** The counts come from string literals. The prompt cap test is the authority; trimming comes first.
- **Dashboard scaling is estimated from code.** TB4 measures it.
- **Agents may not follow the reporting rules.** Compliance is measured by evaluation, and the timeline renders non-compliant agents correctly.
- **Attention predicates could spread.** If "interrupt if blocking" style predicates grow, the registry becomes hidden logic; they stay a closed set.
- **Bounded live events change the stream.** The exact projection is reviewed with TB3.
- **The toast API is marked unstable.** It stays behind the `Toast` primitive.
- **Removing the Details panel migrates landed tests.** TW2 carries that migration.

## Open Questions

- [Non-blocking] Should plan-segment counts be computed by the server (exact) or the client (partial)? The recommendation is the server, in the Extended tier.
- [Non-blocking] Does each adapter emit steps when they start? The Quiet rule depends on it; adapters that report steps only when they finish use the 30-minute "Working" threshold.

## Deferred / Future Work

- [#643](https://github.com/lingkaix/openkit/issues/643): Core-held follow-up, the first item after v0.1.0 (TB8, TW11). More than one held message per Thread is a later question.
- [#644](https://github.com/lingkaix/openkit/issues/644): Thread event stream for failure toasts without an attention row and opted-in completion toasts (G13), with toast coordination across tabs and the choice between the implicit relationship rule and an explicit Watch toggle.
- [#645](https://github.com/lingkaix/openkit/issues/645): page eviction and byte-range body reads.
- [#646](https://github.com/lingkaix/openkit/issues/646): generated catch-up summary.
- [#647](https://github.com/lingkaix/openkit/issues/647): the `shared-chat` profile: addressing, queued simultaneous requests and audience.
- [#648](https://github.com/lingkaix/openkit/issues/648): a live board for several Threads.
- [#649](https://github.com/lingkaix/openkit/issues/649): a seen-through marker for the catch-up anchor (G14).
- [#650](https://github.com/lingkaix/openkit/issues/650): keyboard shortcuts.
- [#651](https://github.com/lingkaix/openkit/issues/651): one "Continue myself" take-over action.
- [#652](https://github.com/lingkaix/openkit/issues/652): user surfaces for a run's Sandbox environment and for policy rules (G19).
- [#653](https://github.com/lingkaix/openkit/issues/653): inline correction judgements on outputs.
- [#278](https://github.com/lingkaix/openkit/issues/278): Decision Trace links from timeline entries (G15).

## Links

- [Web Product Surface Projection](20260628-web_product_surface_projection.md)
- [Unified Conversation Composer](20260831-unified_conversation_composer.md)
- [Pending Requests](20260930-pending_requests.md)
- [Human Attention Intervention Model](20260531-human_attention_intervention_model.md)
- [Thread Visibility And Explicit Sharing](20260909-thread_visibility_and_sharing.md)
- [Task Mode Worker Delegation](20260704-task_mode_worker_delegation.md)
- [Goal](20261002-goal.md)
- [Chat Mode Assistant](20260704-chat_mode_assistant.md)
- [Knowledge Manager Internal Agent Runtime](20260704-knowledge_manager_internal_agent_runtime.md)
- [Internal Agent Runtime](20260813-internal_agent_runtime.md)
- [Worker Context Package](20260703-worker_context_package.md)
- [Work Resource Interaction Model](20260713-work_resource_interaction_model.md)
- [Evaluation Foundation](20261017-evaluation_foundation.md)
- [Codex Worker Adapter](20260716-codex_worker_adapter.md), [Pi Worker Adapter](20260716-pi_worker_adapter.md), [OpenCode Worker Adapter](20260716-opencode_worker_adapter.md) and [DeepSeek Worker Adapter](20260930-deepseek_worker_adapter.md)
- [Web UI Rebuild Stack](20260710-web_ui_rebuild_stack.md)
