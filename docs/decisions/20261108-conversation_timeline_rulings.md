---
status: Accepted
date: "2026-11-08"
decider: Engineer, on the conversation timeline design's recommendations
---
# Conversation Timeline Rulings

## Decision

The engineer made seven rulings on the conversation timeline on 2026-11-08. [Conversation Timeline](../specs/20261108-conversation_timeline.md) owns the resulting contract. The design labels D1–D4 and O7 are kept because the deferred issues cite them.

**D1, live steer per adapter.** `task.steer` is in v0.1.0 and is enabled per Worker adapter after qualification: Codex and Pi first, then OpenCode if its inbox qualifies. DeepSeek is unsupported. Workers on other adapters offer *Keep draft* and *Stop*.

**D2, Personal Assistant handoff state.** The Personal Assistant's "Started a Task" line shows that Task's current state, as a view of existing records.

**D3, no queued follow-up in v0.1.0.** Delivery stays optimistic. A Core-held follow-up is the first item after v0.1.0 ([#643](https://github.com/lingkaix/openkit/issues/643)): NanoCore holds a message sent during a run and delivers it through the ordinary Send path when the run ends. It is not a client-side queue, and it is the fallback for adapters that cannot steer.

**D4, reporting rules within the prompt cap.** The Goal Coordinator prompt is trimmed first to fit the reporting rules. Its cap is raised only if trimming fails.

**O7, held messages after a bad run end.** A held message is not delivered when the run ends failed, stopped or waiting for a decision. It stays held with the reason, and the person chooses Send now, Edit or Cancel.

**Toast scope.** In v0.1.0, toasts fire only for decisions that are or become blocking, and for failures that already raise an attention row and concern work the viewer waits on. Other failure toasts and opted-in completion toasts wait for a Thread event stream ([#644](https://github.com/lingkaix/openkit/issues/644)).

**v0.1.0 scope.** Both the Minimal tier and the Extended tier of the specification's rollout plan are in v0.1.0 and are delivered in slice order. After-v0.1.0 items stay deferred as issues #643–#653. A dedicated UI and UX polish pass of the key parts follows once the core Web slices land.

## Reason

The engineer accepted the four recommendations D1–D4 as proposed, then agreed with the O7 recommendation and accepted the narrowing of the toast scope.

- **D1.** Steer is the only correction short of Stop while a run is in progress. Codex and Pi expose a same-run input hook at their pinned versions; OpenCode's inbox must first prove no spill into later runs; DeepSeek has none. Enabling per adapter after qualification keeps the visible guarantee honest.
- **D2.** The handoff line points at a Task whose state already exists in records. Showing it answers "what happened to that request?" without a result card or a new record.
- **D3.** The engineer clarified, translated from Chinese: "Our current mechanism follows an optimistic model and passes the user's message to the corresponding agent as fast as possible. A queueing mechanism is actually not complex: NanoCore holds the message the user sent and, when a Turn ends, passes the message to the corresponding agent." Because Core holds and delivers the message, it respects the rule that clients do not invent queueing, and it can wait until after v0.1.0.
- **D4.** The Goal Coordinator prompt is already near the built-in prompt cap. Trimming keeps the bounded-prompt rule intact; raising the cap is the fallback.
- **O7.** Delivering a follow-up after a failed or stopped run, or while a decision is pending, would let it act on a broken state. Holding it with the reason leaves the choice with the person.
- **Toast scope.** Only an attention row gives an authorized, viewer-scoped failure source in v0.1.0. A toast without one would need a new channel or an Action Center row created only to feed it. The Thread event stream supplies that source later.
- **v0.1.0 scope.** The engineer stated, translated from Chinese: "All of it counts in the first version; you can arrange the tasks to be completed in order according to the situation and timing." The engineer called the timeline the most important part of the UI and asked for an extra polish pass of its key UI and UX parts and details at a suitable time.

## Rejected Alternatives

- Enabling steer for every adapter at once, rejected because an unqualified adapter could misdeliver input into a later run. Leaving steer out of v0.1.0, rejected because Stop would be the only correction.
- A static "Started a Task" line, rejected because the person would have to open the Task to learn whether it finished.
- A queued follow-up in v0.1.0, deferred rather than rejected. A client-side queue, rejected because clients must not invent delivery.
- Raising the Goal Coordinator prompt cap first, rejected because trimming may suffice and the cap is a deliberate bound.
- Delivering a held message whatever the run outcome, rejected because the follow-up could act on a broken state.
- Toasting every failure and completion in v0.1.0, rejected because no authorized cross-Thread outcome source exists yet and Action Center rows must not be created only to feed toasts.
- Shipping only the Minimal tier in v0.1.0, rejected by the engineer.

## Revisit When

An adapter fails steer qualification or a new adapter gains a qualified same-run input hook; trimming cannot fit the reporting rules into the Goal Coordinator prompt; the Thread event stream lands; or measurement shows that the toast scope misses failures people wait on or interrupts them too often.

## Affected Owners

- docs/specs/20261108-conversation_timeline.md
- docs/specs/20260704-task_mode_worker_delegation.md
- docs/specs/20260831-unified_conversation_composer.md
- docs/specs/20260813-internal_agent_runtime.md
- docs/specs/20260531-human_attention_intervention_model.md
