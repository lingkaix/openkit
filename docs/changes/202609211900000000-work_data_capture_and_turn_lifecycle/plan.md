---
type: change-plan
status: planned
date: "2026-09-21"
---
# Work Data Capture And Turn Lifecycle

## Intent Epoch 1

On 2026-09-21 the engineer authorized locking the work-data retention format in three steps: (1) what to retain, settled as `temp/work-data-retention/proposals/note.md`; (2) storage form and file format, now settled; (3) architecture and technology stack, not started. This plan holds only the implementation work that step 2's decisions already determine. Indexing and search acceleration are out of scope. Source: the engineer's instructions given in the 2026-09-21 working session. The three-step framing and the step rulings are preserved verbatim in `temp/work-data-retention/proposals/format-proposal-v2.md`, Parts 13, 15, 19, and 22. That file is a discussion record, not authority.

## Status

planned. Nothing in this plan has been implemented.

## Design Source

`temp/work-data-retention/proposals/format-proposal-v2.md` is the discussion record for this work line. Its banner names the reading order; only Parts 12–24 are current; earlier parts keep superseded decisions under warning markers. The file holds no design authority. This plan references it rather than copying the scheme. `docs/change-execution.md` owns this bundle's shape; a change record never authorizes design.

## Owners

[`docs/core/protocol.md`](../../core/protocol.md) owns Turn lifecycle vocabulary, terminal immutability, and interruption semantics. [`docs/core/agent-session.md`](../../core/agent-session.md) owns AgentSession continuity. [`docs/core/sandbox.md`](../../core/sandbox.md) and [`docs/specs/20260802-nanohost_runtime_and_transport.md`](../../specs/20260802-nanohost_runtime_and_transport.md) own sandbox runtime records and harness binding. [`docs/specs/20260616-agent_environment_package.md`](../../specs/20260616-agent_environment_package.md) owns the Agent Environment Package. [`docs/specs/20260704-goal_mode_coordination.md`](../../specs/20260704-goal_mode_coordination.md) owns Goal admission, plan approval, and active-plan pointer. [`docs/specs/20260531-worker_turn_reliability_envelope.md`](../../specs/20260531-worker_turn_reliability_envelope.md) owns worker-gate closeout mapping. Listing an item here is not approval of its design under `[AUTH-001]`; each item needs its accepted owner before dependent implementation.

## What Already Landed

The thirteen-file documentation correction is in the working tree and was accepted by an independent Verifier. It is context, not work this plan owes. The files are [`docs/core/protocol.md`](../../core/protocol.md), [`docs/core/agent-session.md`](../../core/agent-session.md), [`docs/core/sandbox.md`](../../core/sandbox.md), [`docs/core/runtime-model.md`](../../core/runtime-model.md), [`docs/specs/20260531-worker_turn_reliability_envelope.md`](../../specs/20260531-worker_turn_reliability_envelope.md), [`docs/specs/20260629-worker_runtime_communication_model.md`](../../specs/20260629-worker_runtime_communication_model.md), [`docs/specs/20260703-durable_scheduler_design.md`](../../specs/20260703-durable_scheduler_design.md), [`docs/specs/20260703-runtime_scheduling_scale.md`](../../specs/20260703-runtime_scheduling_scale.md), [`docs/specs/20260703-worker_control_protocol.md`](../../specs/20260703-worker_control_protocol.md), [`docs/specs/20260704-agent_session_continuity.md`](../../specs/20260704-agent_session_continuity.md), [`docs/specs/20260704-task_mode_worker_delegation.md`](../../specs/20260704-task_mode_worker_delegation.md), [`docs/specs/20260802-nanohost_runtime_and_transport.md`](../../specs/20260802-nanohost_runtime_and_transport.md), and [`docs/specs/20260910-persistent_worker_volumes.md`](../../specs/20260910-persistent_worker_volumes.md). Named validator results at that acceptance: `node scripts/validate-doc-model.mjs` reported `Validated documentation model (277 documents).`; `node scripts/validate-spec-lifecycle.mjs` reported `Validated spec lifecycle metadata.`; `node scripts/generate-doc-index.mjs --check` reported `Documentation index is current.`; `node scripts/validate-agent-session-terminology.mjs` passed 2/2 tests.

## Work Items

These items are not a schedule, queue, or package sequence. Each names a change, the owner that must decide it, and what is still missing before implementation may start.

### 1. Turn terminal publication boundary

After a Turn is terminal, `updateTurn`, `createItem`, and `emitTurnEvent` admit only completion of an already-decided publication, judged by identity, not by time. The three guards are one rule applied three times. The existing shape is the presence-keyed idempotent repair at `apps/nanocore/src/runtime/worker-turn-failure.ts:115-152`. A sweep of ten call sites established that a blanket "no writes after terminal" rule would break at least four legitimate paths. [`docs/core/protocol.md`](../../core/protocol.md) owns terminal immutability and "MUST NOT be reopened or rewritten"; it does not yet state the identity-keyed publication exception. Missing before start: that exception admitted by the Turn-lifecycle owner, plus a focused regression covering legitimate post-terminal completion of already-decided publication versus rejected new writes. Source: R51.5's exclusion note and R44.5's guard section as corrected by R45.5.

### 2. Goal revision failure handling

The engineer ruled that a planner failure during plan revision preserves the scene and lets the user decide, keeping the Goal alive so work can continue on the same goal path. `reviseGoalPlan` currently sets the Goal to `planning` with a null `planItemId` (`apps/nanocore/src/runtime/goal-plan-approval.ts:292-299`), and `goal.plan` admits exactly that state (`apps/nanocore/src/goal-routes.ts:3162`), so after a failure the user can retry planning but cannot approve the old plan or issue a fresh revision instruction. [`docs/specs/20260704-goal_mode_coordination.md`](../../specs/20260704-goal_mode_coordination.md) owns Goal admission, plan approval, and the active-plan pointer. Missing before start: a coherent Goal admission and active-plan-pointer transition under that owner, plus a focused regression covering revise, planner failure, fresh planning retry, fresh revision instruction, and old-plan approval. Source: R46.1 as corrected by R50.7.

### 3. Measured harness identity

Stop treating the authored `runtimeVersion` on the Agent Environment Package as a measured harness version. Reference the measured `sandbox_runtime_records.image_digest` instead, captured at binding time for both new and reused bindings, because the row is deleted on cleanup. [`docs/specs/20260616-agent_environment_package.md`](../../specs/20260616-agent_environment_package.md) owns the authored package; [`docs/specs/20260802-nanohost_runtime_and_transport.md`](../../specs/20260802-nanohost_runtime_and_transport.md) owns sandbox runtime records and binding. Missing before start: those owners stating that measured harness identity is the binding-time digest rather than authored `runtimeVersion`, and capture on both new and reused bindings. Source: R44.6(a) as corrected by R45.6 and R46.3.

### 4. System prompt digest capture

Declare one semantic boundary — the prompt before adapter conversion — and account for the actual conversion paths rather than promising a single existing hook: Chat calls reach it through one converter while Codex and bridged Responses reach it through another (`apps/nanocore/src/llm/pi-ai-client.ts:284-300`). The grouping is not injective: an absent prompt and an explicit default literal produce different pre-adapter digests and identical outgoing instructions. No accepted owner yet holds the capture record; the LLM conversion paths are implementation fact under the existing pi-ai client. Missing before start: an accepted owner for the digest record that states the semantic boundary and the non-injective grouping, without requiring a single hook. Source: R46.2 as corrected by R50.8.

### 5. Coverage binding

The resolved effective retention setting is fixed at Turn admission and written into `turn.json`, which is already rewritten on every persist, so this adds no new file. A setting change takes effect at the next Turn; an already-started Turn is never interrupted. The switch defaults to off. [`docs/core/protocol.md`](../../core/protocol.md) owns Turn admission and when the effective setting is fixed; [`docs/specs/20260703-storage_layout_record_ownership.md`](../../specs/20260703-storage_layout_record_ownership.md) owns what `turn.json` carries. The E3 ruling in R41 and R42 is the engineer decision. Missing before start: the admission-time field on `turn.json` and the default-off switch under those owners, without a mid-Turn interrupt path.

## Explicitly Not In This Plan

The storage-form implementation itself waits for step 3, which decides architecture and technology stack. Observation, not a decision: [`docs/specs/20260703-storage_layout_record_ownership.md`](../../specs/20260703-storage_layout_record_ownership.md) `:286` already describes observation ledgers and workspace JSONL ledgers carrying a per-line `v`, `type`, `id` and `ts` header with `ownerScope`, lineage defaults and `requiredFeatures` in a directory-level manifest, so that spec is the likely receiver when step 3 promotes the retention format into an accepted owner, rather than a brand-new specification. The delayed-user-input design line is separate and entered at `temp/delayed-user-input/`. The AgentSession uncertainty axis has no accepted owner. Listing future work here is not approval of its design: each item needs its accepted owner before dependent implementation, under `[AUTH-001]`.

## Checkpoint

Status: planned. Nothing in this plan has been implemented. Current facts: the thirteen-file documentation correction is in the working tree and Verifier-accepted; Core Turn terminals are `completed`, `interrupted`, `cancelled`, and `failed`; `unknown` is not a Turn status. Material unknowns: no accepted owner yet for unifying the two denial-path terminals, for the approval-route replay crossover, for AgentSession uncertainty, or for the prompt-digest capture record. Method: do not start an item until its accepted owner covers the missing contract named above; do not invent a package queue. Frontier: documentation landing closed; implementation not started. Predicted Next Action: none until an accepted owner covers a named item.

## Findings

Two open findings with no accepted owner live in [`findings.md`](findings.md). They are not work this plan owes until an engineer or accepted owner admits them.

## Closeout

Not started. Closeout records actual implementation, commits, exact verification, unresolved findings, and residual risk when work ends.
