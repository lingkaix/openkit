---
status: Accepted
date: "2026-10-09"
decider: Engineer
---
# Truthful Native Stop Classification

## Decision

The engineer decided on 2026-10-09 to correct native stop classification and use explicit new-Turn or existing Goal Coordinator continuation. The source report and all three rulings below are preserved verbatim; the English explanations are translations and scope summaries.

Report: 「有一些 worker harness在运行过程当中不稳定，有可能在运行过程当中自行出错中断，这种情况也需要处理。比如pi agent 在长期运行过程当中，它会自行中断任务。」

1. Route: 「修正停止分类（OpenCode length 不再判成功，已知上限保留为 length），Task 仍是一次有界尝试；续跑通过新 Turn 或已有的 Goal Coordinator，不自动重试（推荐）」.
2. Release: 「等：停止分类修复（含 OpenCode length 假成功）在候选上证明后再发（推荐）」.
3. Evidence: 「在 A2 上用 Pi agent 跑一个长 Task 来复现（如果 A2 已配置 Pi）」.

The approved route is alternative B with C: preserve positively proved native output/context limits as the existing `length` result, classify runtime self-stops without an OpenKit interrupt or cancellation request as `error`, and retain one bounded Task attempt. Continuation uses a new authorized Turn on the same Task Thread or an existing Goal Coordinator decision. It does not resend the old native prompt or repeat an external effect with an unknown outcome. Runtime-native retries inside one admitted prompt stay unchanged. No automatic Task retry, harness restart loop, prompt replay, watchdog, StopReason, durable record, state, or lifecycle is added.

The release is held until the stop-classification fix, including OpenCode length false success, is proved on the candidate. This ruling supplies no release approval and removes no other release gate. The requested long Pi Task observation on A2 is pending evidence, conditional on Pi already being configured there. It is an operator observation, not a design input or a completed reproduction.

## Reason

The engineer reports that worker harnesses can stop on their own during long work, with Pi as an example. The desired outcome is truthful attempt status and authorized continuation from inspectable evidence. Native completion is not proof that the user's objective was achieved, and native interruption is not proof that a user cancelled the work.

The Consultant's source inspection identified a concrete OpenCode defect: correlated successful idle with assistant finish `length` was classified as completed success, losing explicit limit evidence. Pi native `length` and DeepSeek `max_tokens` were instead collapsed to `error`. The approved correction preserves those known limits without inventing budget exhaustion. DeepSeek `max_turn_requests` and `refusal` remain `error`; Codex limit classification changes only when native evidence positively proves an output or context limit. Pi already distinguished native self-abort from an OpenKit interrupt request; the same provenance rule applies to all four harnesses. These are inspected defects and mappings, not a reproduction of the reported long Pi incident.

The existing Reliability envelope already maps worker-control `blocked/length` to a completed Turn and checkpoint with StopReason `length` and a blocked Task. Its closeout, fencing, retained-data, and restart owners remain in place. The private adapter result needs only to carry that existing non-success outcome to the shared Harness. Goal already provides Plan-bounded Coordinator decisions after linked Task terminal facts; a second Task continuation controller is unnecessary for the chosen route.

## Rejected Alternatives

- Standalone Task automatic continuation (alternative D) was rejected because the engineer retained the bounded-attempt contract and selected the existing Goal route. Automatic continuation would need a separate objective/evidence oracle, cost and stop policy, and authority for another attempt; runtime failure alone supplies none of them.
- Classification only, without the selected explicit continuation route, was rejected as the complete response because truthful status alone does not describe how unfinished authorized work can proceed. The selected new Turn or existing Goal Coordinator supplies that route without automatic retry.
- Keeping current behavior with disclosure (alternative A) was rejected because disclosure leaves the known OpenCode length false-success defect. The engineer chose to hold release until the correction is proved on the candidate.

## Revisit When

Revisit the route if exact incident evidence establishes that truthful classification and explicit new-Turn or existing Goal coordination cannot meet the required long-work experience, and the engineer accepts a different continuation contract with its authority, effect-uncertainty, cost, and stopping predicates. A pending Pi observation, native retry, or local synthetic pass alone does not change the route or satisfy the candidate release hold.

## Affected Owners

- [Worker Turn Reliability Envelope](../specs/20260531-worker_turn_reliability_envelope.md#stop-reason-contract) owns StopReason definitions and [canonical closeout](../specs/20260531-worker_turn_reliability_envelope.md#worker-turn-envelope).
- [Worker Runtime Communication Model](../specs/20260629-worker_runtime_communication_model.md#adapter-normalized-stop-outcomes) owns the private adapter-normalization seam.
- [OpenCode Worker Adapter](../specs/20260716-opencode_worker_adapter.md#native-output-mapping), [Pi Worker Adapter](../specs/20260716-pi_worker_adapter.md#native-output-mapping), [DeepSeek Worker Adapter](../specs/20260930-deepseek_worker_adapter.md#native-output-mapping), and [Codex Worker Adapter](../specs/20260716-codex_worker_adapter.md#native-output-mapping) own their native evidence mappings.
- [Task Mode Worker Delegation](../specs/20260704-task_mode_worker_delegation.md#summary) preserves one bounded attempt and its no-automatic-retry rule.
- [Goal](../specs/20261002-goal.md#coordinator-role) already owns Coordinator admission of ordinary Tasks; its design is unchanged.
- [Durable Scheduler Design](../specs/20260703-durable_scheduler_design.md#attempt-reconnect-and-cleanup) keeps cancellation precedence, exclusion, and cleanup authority; its design is unchanged.
- [Release Management](../specs/20260829-release_management.md) retains its existing candidate acceptance and release gates in addition to this hold.
