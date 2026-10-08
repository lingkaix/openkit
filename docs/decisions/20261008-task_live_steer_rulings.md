---
status: Accepted
date: "2026-10-08"
decider: "Engineer"
---
# Task Live-Steer Rulings

## Decision

The engineer's rulings on 2026-10-08 are preserved verbatim from the writer dispatch:

1. Verbatim answer to "is a live-steer operation wanted": 「和task mode一致，需要具有 steer操作」.
2. Goal recipient: steering a Goal's running worker means steering its exact Task Thread and Turn through the Task operation. The Goal Coordinator does not accept steer; changing intent still uses revise intent or card edits. Goal adds no operation.
3. Visible guarantee: success means the runtime accepted the instruction for native processing during the addressed Turn. It does not promise that the model reads or obeys it. Unsupported and unknown outcomes are shown explicitly.

The English translation of ruling 1 is: “Consistent with Task mode, it needs a steer operation.” The quotation above remains the source wording.

[Task Mode](../specs/20260704-task_mode_worker_delegation.md#live-steer) owns the accepted contract: one public `task.steer` addresses an exact running Task Thread and Turn, records an ordinary user-message Item, preserves the original execution and authority, and uses one private `turn.steer`. Goal workers compose that Task operation; the Coordinator is excluded. Native runtime support is conditional on each adapter's qualification, and DeepSeek at the current ACP pin remains unsupported. These rulings do not themselves qualify an adapter or claim implementation acceptance.

This record supersedes the live-steer exclusion in the affected active Goal, human-attention, worker-reliability, and adapter owners only to the extent of this exact Task recipient and native-acceptance contract, going forward. It leaves ordinary busy submission, Pending Request delivery, the ten Goal operations, Plan and completion authority, and [interrupt as abandonment](20260921-turn_interrupt_is_abandon.md) intact. Historical decision records, archived specifications, and audits remain unchanged; in particular, [Goal Contract Gap Rulings](20261002-goal_contract_gap_rulings.md) retains its original Plan and request decisions rather than being rewritten to imply prior steer support.

## Reason

The independent consultant recommended an explicit same-Turn Task input boundary because interrupt followed by another Turn abandons ongoing work, while recording text without native acceptance cannot truthfully establish delivery. Exact targeting, retained attempt evidence, and non-redelivery preserve delivery truth through races and response loss without restoring a cross-Turn queue. Those are the consultant's reasons for the recommended contract, not additional engineer quotations. The engineer settled the recipient and visible-guarantee choices through rulings 2 and 3; the dispatch records no separate engineer reason for them.

The source material is the 2026-10-08 writer dispatch at `temp/interface-unification/build/write-spec-steer.md` and the independent consultant report at `temp/reports/consult-steer/consult.md`, held outside this worktree under the repository's temporary work area. The accepted rules live in the linked owners; temporary reports provide rationale and evidence rather than authority.

## Rejected Alternatives

- Interrupt followed by another Turn as the meaning of steer: it does not supply input during the addressed running Turn and would change the accepted abandonment semantics.
- Live steer to the Goal Coordinator, a new Goal operation, implicit worker broadcast, or a Goal input queue: ruling 2 selects the exact Task worker recipient and existing Goal intent/card operations.
- Success that promises model reading or obedience: ruling 3 chooses native acceptance for processing, with explicit unsupported and unknown results.
- Automatic uncertain-effect resend, cross-Turn input promotion, or a custom adapter queue: the accepted Task contract preserves exact execution and truthful uncertainty instead of adding eventual delivery authority.

## Revisit When

Revisit the recipient decision if the engineer requests live input to the Coordinator's internal runtime. Revisit the visible guarantee if a product need requires correlated consumption evidence rather than native acceptance. Return a concrete finding to the engineer if an adapter or the existing storage/slot seam cannot prove exact same-Turn delivery, write-before-dispatch, result-before-slot-reuse, bounded interrupt delivery, or prevention of stale native input on successor work; do not infer broader authority from these rulings.

## Affected Owners

- [Task Mode Worker Delegation](../specs/20260704-task_mode_worker_delegation.md#live-steer)
- [Human Attention Intervention Model](../specs/20260531-human_attention_intervention_model.md)
- [Worker Control Protocol](../specs/20260703-worker_control_protocol.md#live-steer-operation-boundary)
- [Worker Turn Reliability Envelope](../specs/20260531-worker_turn_reliability_envelope.md)
- [Goal](../specs/20261002-goal.md)
- [Unified Conversation Composer](../specs/20260831-unified_conversation_composer.md#explicit-live-input)
- [Codex Worker Adapter](../specs/20260716-codex_worker_adapter.md#live-steer-mapping-and-qualification)
- [Pi Worker Adapter](../specs/20260716-pi_worker_adapter.md#live-steer-mapping-and-qualification)
- [OpenCode Worker Adapter](../specs/20260716-opencode_worker_adapter.md#live-steer-mapping-and-qualification)
- [DeepSeek Worker Adapter](../specs/20260930-deepseek_worker_adapter.md#live-steer-refusal-and-qualification-boundary)
