# Worker Turn Reliability Envelope

Status: Accepted
Implementation: Partial

## Owns

This spec owns the implementation-facing reliability envelope for the direct Quick Chat provider call and worker-turn execution, including stop reasons, terminal stream behavior, item-to-LLM projection, runtime checkpoints, delivery of an already accepted worker request, restart-safe terminal handoff after exact same-worker adoption, and deferred context-compaction boundaries.

## Does Not Own

This spec does not own stable core workflow vocabulary, user-facing work labels, worker selection, semantic worker-request composition, user-input delivery semantics, worker-control wire commands or reconnect authorization, workspace synchronization, runtime lease adoption, agent manifest resolution, Agent Environment Package schemas, or UI recovery layouts. S15 owns worker selection and semantic request composition; S16 owns accepted active-Goal user input and its delivery proof.

## Core References

- `docs/core/agent-workflow.md`
- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/knowledge.md`

## Summary

OpenKit should harden worker execution and the direct Quick Chat provider call without growing a second agent runtime.

Quick Chat uses one direct bounded call with timeout, cancellation, schema validation, redacted errors, and no private workflow state. Worker turns retain stable stop reasons, explicit item-to-LLM projection, exact accepted-request delivery, runtime checkpoints, and the deferred context-compaction boundary defined below.

The first implementation should stay app-local in `apps/nanocore`, except for the stable stop-reason enum and terminal stream contract, which should be promoted into `packages/protocol` and `docs/core/protocol.md`.

This spec refines the earlier lightweight-agent and Sustained Mode specs by defining the minimum runtime primitives needed before long-running delegation can be reliable.

## Goals / Non-goals

Goals:

- Preserve the stable `Workspace -> Thread -> Turn -> Item[]` Core model.
- Keep the current Quick Chat provider call direct, bounded, and owned by that concrete role.
- Define stable stop reasons for provider, worker, and gateway streams.
- Introduce a `convertToLlm` boundary so durable item history and provider-visible context are separate.
- Add only the worker-turn reliability primitives required to deliver one accepted Coordinator request, observe one bounded execution, checkpoint it, and recover its terminal handoff.
- Defer autonomous context compaction until OpenKit has real long-running sessions and enough history to compact.

Non-goals:

- Do not introduce `AgentRun`, `TaskRun`, or a task graph as stable Core concepts.
- Do not introduce a generic internal-agent runner, registry, private event vocabulary, hook framework, tool allowlist, or unused streaming surface.
- Do not expose NanoCore Internal Core Role implementation details as protocol records.
- Do not require low-level provider clients to never throw.
- Do not force every stream failure to appear as assistant prose.
- Do not implement background context compaction or autonomous Knowledge Store editing in this design slice.
- Do not add new Internal Core Roles as part of the envelope.

## Background

OpenKit already has the right foundation: the protocol remains a work log of workspaces, threads, turns, and items, while NanoCore can own app-local runtime state.

The current product needs only direct non-streaming Quick Chat provider calls. Workflow Coordinator is a deterministic Internal Core Role and does not use a provider runner. A generic loop, registry, hook system, event protocol, and private streaming facade therefore add unowned capability rather than reliability.

## Decision

OpenKit will introduce a worker-turn reliability envelope with app-local runtime pieces and a small protocol promotion.

The protocol promotion is limited to a stable `StopReason` enum and a rule that once a stream has started, failures must be encoded as terminal events or terminal items rather than escaping as transport errors.

All other pieces begin in `apps/nanocore`: the direct Quick Chat provider call, runtime checkpoints, context package projection, accepted-request delivery, and worker-turn stop policy.

Because this repository is still in internal development, implementation may break app-local shapes where that gives a cleaner design.

### Reliability Posture

This envelope is designed for the current small-deployment baseline: one NanoCore process, one logical SQLite writer, one configured local or remote runtime target, and one active worker slot. Its strict guarantees protect authorization, durable authority, exact lineage, non-duplication of accepted external effects, and truthful terminal projection; they do not promise distributed-system availability or transparent repair of every interrupted write.

When the existing owners cannot prove whether an external effect occurred or cannot derive one unambiguous closeout tuple, `recovery_required`, an explicit interrupted or uncertain outcome, inspection, and a fresh authorized attempt are accepted fallbacks. NanoCore MUST NOT infer success, launch a compatible replacement, synthesize missing authority, or add a settlement workflow merely to hide that interruption.

Possible future multi-process scheduling, multi-writer storage, high availability, hot failover, multiple active targets, or stronger fairness requirements do not authorize present states, abstractions, recovery paths, runners, or test matrices. Any such expansion requires a separately accepted design based on a demonstrated deployment need.

## Accepted Design

### Layer Ownership

The design has three ownership layers.

`packages/protocol` owns stable stop reasons and terminal stream semantics.

`apps/nanocore` owns concrete Internal Core Role services, worker-turn checkpoints, context packages, and worker adapter orchestration.

Worker adapters own runtime-native details such as Codex session ids, OpenCode session ids, provider request ids, tool-call ids, sandbox commands, and process handles.

## Current Implementation Projection

The shared `StopReason` protocol and initial worker-turn envelope are implemented, but this specification remains Partial. The active restart slice reuses the existing checkpoint and terminal handoff for the surviving worker rather than adding a recovery workflow. Terminal `turn.completed` events carry `stopReason` on the event envelope, not on the durable `Turn` record.

NanoCore has deleted the generic internal-agent runner, registry, event loop, hooks, tool allowlists, diagnostics ledger, and unused private streaming path. Standalone Quick Chat and the thread-scoped Chat fallback now share one concrete role function inside the existing mode service. That function resolves the authorized provider through the existing resolver, dispatches through the existing Gateway dispatcher, projects the fixed system instruction plus one user prompt, propagates caller cancellation, races the call against the 30-second role timeout, validates non-empty assistant text, and returns no private durable state or event lifecycle.

The direct call boundary now maps provider rate limits, other typed provider errors, role timeout, caller abort, invalid content, and unexpected executor failure to the exact redacted codes and statuses below. Focused tests prove the exact message projection, a timeout against a provider that ignores cancellation, caller abort, invalid content, redaction, usage lineage, cache scope, credential resolution, and replay without reviving the deleted runtime. This closes the C03 generic-runtime defect, but not the whole worker reliability envelope: thread-scoped Chat still dispatches before its failure Turn and Item tuple is durable, while immutable Context Package delivery proof and broader recovery remain incomplete.

NanoCore also has the first app-local worker-turn envelope through `runWorkerTurnLoop()`, worker checkpoint tables, `prepareNextTurnContext()`, interrupted-worker read-model materialization, terminal checkpoint cleanup, and interrupted-checkpoint retry-to-ready recovery. Goal and direct Task closeout share one StopReason classifier over the exact checkpoint, Turn, Agent Session, agent, lease, event, evidence, and command lineage. An AEP-backed envelope additionally requires its exact accepted worker-control final status, backend-session cleanup, and workspace handoff; the bounded in-process fallback is permitted only when that Agent Session has no AEP snapshot, backend-session owner, or worker-control owner. Online and restart AEP closeout share the canonical mapping for accepted non-Gate `completed`, `length`, `budget_exhausted`, `aborted`, and `error` outcomes rather than converting every non-completed status to `error`. Direct Task and Goal worker user-input and approval Gate responses now close the old envelope without resuming its adapter, retain the exact request and response or decision evidence, apply the owning mode transition, release scheduler ownership before publishing the response receipt, and delete the checkpoint only after the complete owner tuple and applicable command receipts agree. The S31 `repo.push` policy Gate now derives one deterministic owner from command identity, fails closed when that owner lacks its receipt, and closes the gated Turn without runtime continuation; it is not a generic worker Gate path. Boot now performs scheduler and worker-control fencing before scanning every uncleared checkpoint through the same Task or Goal classifier used online; complete tuples close, live or reconnecting attempts remain untouched, and incomplete or contradictory tuples retain their checkpoint and degrade scheduler readiness to `recovery_required`. The bounded AEP `blocked/ask_user` fallback below handles a runtime that cannot name an exact Core Gate without synthesizing one. Exact S39 Context Package delivery proof and bounded S16 Goal steering are implemented over existing owners; broader recovery discovery remains incomplete, so this specification remains Partial.

The former generic pending-user-turn table, module, queue drain, worker-context injection, recovery actions, import/export family, public deterministic recovery seed, first-party client methods, removal-only MCP tools, and dedicated recovery story remain deleted because they lacked exact Goal and active-Turn lineage, a terminal claim, and immutable delivery proof. S16 now reintroduces only one Thread-unique Goal pending owner with exact Item, original Goal and Turn, Material, claim, and command proof; accepted delivery is proven only by the matching S39 trace, while terminal follow-up and cancellation use their bounded immutable outcome. The Goal step path binds every checkpoint to `requestId`, canonical input hash, Goal, Task, and a deterministic request-derived Turn; one Workspace transaction reserves the first ready Task under its runnable Goal, records the allowed worker-launch permission decision, and writes the `preparing` checkpoint. Receipt lookup precedes mutable Goal, Task, Coordinator, and context selection; a complete terminal owner tuple may publish a missing bounded receipt, the receipt is durable before terminal checkpoint cleanup, and any unresolved checkpoint for the Goal blocks a competing step reservation. The checkpoint remains launch-fence and diagnostic evidence while S39 separately owns immutable worker-request and Context Package delivery proof; an unprovable failure after the fence returns `recovery_required` without rerunning Coordinator, reselecting context, or launching a replacement. This path reuses the command ledger, Goal and Task records, PermissionDecision, Turn, checkpoint, and terminal owners and adds no settlement workflow or recovery engine. Broader recovery discovery keeps this specification Partial. Caller-selected `record_terminal`, its public route, schemas, projections, legacy MCP tool, and positive tests remain removed; internal checkpoint cleanup is callable only from existing mode-owned closeout paths. Product recovery may expose inspection, retry after authoritative interruption, partial-Artifact review, or guidance through their existing owners, but it does not let a caller assert worker terminal state, invent a generic abort, or request adapter-native resume.

The active restart slice keeps the checkpoint nonterminal while the exact lease is `awaiting-reconnect`, then continues terminal observation for the same Turn after process-key adoption or projects an anchored cleanup as an interrupted Turn and Session after timeout. Interrupted-worker rows and Action Center retry now require the exact terminal lease, product interruption, checkpoint, and continuation predicate below; `awaiting-reconnect`, live or adopted leases, incomplete cleanup, ordinary checkpoints, and contradictory Goal lineage cannot expose or execute retry.

The current context-package implementation is a first projection slice: item-to-LLM conversion records deterministic context package digests, included item ids, excluded item decisions, and attachable records, while full file-backed worker package materialization and replay remain owned by `docs/specs/20260703-worker_context_package.md`.

The first real governed worker path is the OpenShell/Codex worker-governance path.
OpenCode can conform through the same worker-turn envelope later, but runtime checkpoints are a NanoCore worker-loop responsibility rather than an adapter-specific contract.

### Stop Reason Contract

The stable stop reason enum should be shared by provider streams, worker adapter streams, and gateway streams.

```ts
type StopReason =
  | 'completed'
  | 'error'
  | 'aborted'
  | 'length'
  | 'ask_user'
  | 'budget_exhausted';
```

`completed` means the turn reached a normal terminal state.

`error` means the runtime failed after accepting or starting the operation.

`aborted` means a user, system, or cancellation signal stopped the operation intentionally.

`length` means the model or runtime stopped because an output or context limit was reached.

`ask_user` means the runtime cannot continue without explicit user input or approval.

`budget_exhausted` means the thread or turn budget is exhausted and no new substantive work should start.

Low-level provider clients may still throw.

The stream adapter boundary must catch provider, parser, timeout, and adapter errors after the stream starts and encode them as a terminal event or terminal item with a redacted `errorCode` and `errorMessage`.

Before a stream starts, HTTP validation and auth failures may still use normal HTTP errors.

After a stream starts, the caller should see a well-formed terminal record, never a half-open stream that dies without a stop reason.

NanoCore's LLM Gateway wraps Chat Completions and Responses SSE streams at the route boundary. If a provider or bridge stream throws after the request has been accepted, the wrapper appends a redacted OpenAI-compatible SSE error payload with `stopReason: "error"` and then emits `[DONE]`.

### Direct Internal Core Role Calls

A provider-backed Internal Core Role call MUST be owned by one concrete role function rather than a generic runner or registry. The role function owns its fixed system instruction, bounded input projection, output schema, and timeout.

The caller MUST resolve the authorized provider and model before invocation. Quick Chat and the thread-scoped Chat fallback derive that selection exclusively from `defaults.coreProviderId` and `defaults.coreModel`; their public request schemas accept neither `providerId` nor `model`, and they do not fall back to Gateway defaults, provider-profile defaults, caller input, or adapter catalogs. The selected provider profile MUST be dispatchable before the role resolves credentials, and the selected model MUST appear in that profile's explicit `models` list before any adapter call. The role function MUST reuse the existing provider dispatcher and provider resolver, propagate caller cancellation, add the bounded role timeout, validate the returned content, and return or throw without creating private durable state.

Quick Chat is the only current provider-backed Internal Core Role call in this slice. The same concrete role function also owns the thread-scoped Chat fallback. It projects one user prompt plus its fixed system instruction, has a 30-second timeout, and returns one validated provider response. Workflow Coordinator remains a deterministic Core service and MUST NOT be registered or diagnosed as a provider-backed runner.

Malformed JSON, schema-invalid input, or a caller-supplied `providerId` or `model` MUST fail before provider selection or dispatch as `invalid_request` with HTTP 400. Missing `defaults.coreProviderId` or `defaults.coreModel` MUST fail before dispatch without fallback as `quick_chat_not_configured` or `chat_mode_not_configured` with HTTP 400 at the owning route. Typed upstream provider errors retain `provider_rate_limited` with HTTP 429 or `provider_request_failed` with the upstream HTTP status, but their public messages are the stable OpenKit messages `Provider rate limit exceeded.` and `Provider request failed.` rather than redacted upstream text. Role timeout returns `provider_call_timeout` with HTTP 504, caller abort returns `provider_call_aborted` with HTTP 499 when the response channel remains writable, and missing or invalid assistant content returns `provider_response_invalid` with HTTP 502. Any other executor failure returns the owning route's `quick_chat_failed` or `chat_mode_failed` with HTTP 500.

Every public provider error code and message MUST come from the stable OpenKit projection above. Upstream messages, codes, types, response bodies, adapter vocabulary, and stack traces remain private even when redaction would remove known secret markers. No failed invocation may return or persist a `completed` result.

Standalone Quick Chat has no replay contract: each HTTP retry is a new provider invocation and may incur new usage. Thread-scoped Chat Mode inherits the existing App API command-idempotency contract from S11: replay of the same accepted request id returns the original durable Chat lineage without another provider call, while a user-requested new attempt uses a new request id. This bounded compromise reuses the command owner and adds no inference settlement workflow.

Provider selection diagnostics, durable CapabilityCall and UsageRecord attribution, audit, and public error projection remain with their existing owners. The role function MUST NOT add a second provider registry, failure ledger, tool executor, hook chain, event protocol, or workflow lifecycle.

A future streaming product need requires an accepted public App API or protocol contract and a real consumer first. Its implementation MUST project the existing provider stream through the owning public route and MUST NOT revive a private parallel event model or unused streaming facade.

### Item To LLM Projection

OpenKit's durable history is an item log.

Provider-visible context is a projection of that log, not the log itself.

NanoCore should introduce a `convertToLlm` boundary.

```ts
function convertToLlm(
  items: readonly OpenKitItem[],
  policy: LlmProjectionPolicy
): LlmProjectionResult;
```

The result should include provider messages, referenced item ids, excluded item ids with reasons, token estimates when available, and a context package digest.

The projection policy decides which items are model-visible, summarized, elided, or UI-only.

Examples of UI-only or audit-only items include status rows, artifact pointers, approval markers, protocol diagnostics, and terminal state records.

Examples of model-visible items include user instructions, assistant text, selected tool results, approved knowledge or context injections, and explicit worker handoff context.

The projection must be recorded for worker turns so debugging can answer what the worker saw.

The projection should not mutate the item log.

### Worker Turn Envelope

The worker-turn envelope is the app-local execution state machine shared by bounded Task and Goal worker delegation.

The accepted V1 checkpoint stages are exactly:

```text
preparing
running_worker
waiting_for_user
completed
failed
aborted
```

No checkpoint row represents `idle`; absence of a row is idle. `reviewing` remains with the Goal and Review owners, verification remains an evidence record rather than a Goal or checkpoint lifecycle state, and workspace saving remains with workspace handoff; none may be copied into the worker checkpoint. Reconnect remains the scheduler lease's `awaiting-reconnect` recovery state while the checkpoint stays `running_worker`; it is not another worker stage.

| Current stage | Permitted next stage | Required predicate |
| --- | --- | --- |
| no row | `preparing` | The owning mode has reserved one exact Turn id and written the request id, input hash, nullable Goal and Task ids, Turn lineage, and allowed worker-launch PermissionDecision into the same Workspace transaction as this checkpoint; non-null matching Goal and Task ids identify Goal Mode, while both null identify Task Mode. Goal Mode also changes the exact first ready Goal Task to `running` and its runnable Goal to name that Task in the transaction; Task Mode has no Goal Task owner. |
| `preparing` | `running_worker` | The exact reserved Turn is bound to its first scheduler admission, lease, Agent Session, and worker execution lineage. Exact command replay may perform a not-yet-started first launch only when an immutable mode-owned request trace proves the same prepared worker request and Context Package under the reserved identities. Without that trace, a request-bound checkpoint with no complete launch effect returns `recovery_required`; it never reruns Coordinator, reselects context, or launches a replacement. Any half checkpoint/Task pair, duplicate effect, or contradictory lineage also returns `recovery_required`. |
| `running_worker` | `waiting_for_user` | The same worker Turn durably owns an active user-input or approval gate and `stopReason=ask_user`. |
| `waiting_for_user` | `completed` or `aborted` | The exact gate owner attaches its response or decision Item to the same active Turn as required by Core protocol and closes the original envelope without resuming worker execution. A submitted answer or granted approval produces terminal stage and envelope-close `stopReason=completed`; a denied approval produces terminal stage and envelope-close `stopReason=aborted`. Both retain the exact original `ask_user` request plus response or decision pair in checkpoint evidence; neither claims that the worker itself later returned `completed` or `aborted`. Any further worker execution is a separately authorized Task or Goal command with a new Turn and request id. |
| `running_worker` | `completed`, `failed`, or `aborted` | The exact worker Turn and terminal evidence own the matching StopReason. |
| `completed`, `failed`, or `aborted` | no further stage | Worker execution is terminal, but the uncleared checkpoint remains discoverable until every durable owner required by the initiating mode, evidence, review, workspace handoff, Agent Session, backend, and lease contracts completes closeout. |

Every uncleared checkpoint is a restart candidate, including a terminal-stage checkpoint. A terminal stage proves only that worker execution ended; it does not prove that Task or Goal closeout committed. Restart reuses the named owners to finish the already-authorized closeout when their complete tuple is deterministic, otherwise it returns `recovery_required`. It MUST NOT skip a terminal checkpoint, infer workflow completion, or create a settlement owner.

Restart classification is derived from the existing records and is not persisted as another recovery lifecycle:

| Existing durable tuple | Only permitted result |
| --- | --- |
| Live lease or lease at `awaiting-reconnect` | Preserve the current attempt; do not close, retry, replace, or clear its checkpoint. |
| Releasing lease with an accepted final status | Finish generic Turn, Session, evidence, backend, lease, and capacity closeout, then invoke the initiating mode's closeout against the same checkpoint. An accepted raw `blocked/ask_user` without an exact Core Gate instead uses the bounded interruption fallback below and never invokes a Gate or mode closeout. |
| Nonterminal checkpoint whose exact Turn and Session are interrupted after scheduler cleanup | Apply only the existing interrupted-worker recovery predicate; no terminal closeout or replacement is inferred. |
| `waiting_for_user` checkpoint | Preserve the exact gate owner; a missing or contradictory gate tuple remains discoverable as `recovery_required`. |
| Terminal checkpoint with the complete initiating-mode tuple and command receipt | Validate the complete tuple, then perform only the exact checkpoint cleanup. |
| Terminal checkpoint with the complete request-owned initiating-mode tuple but no command receipt | Only an unambiguous direct `task.start` or `goal.step` owner may publish its deterministic missing receipt after validating every tuple member against the checkpoint and immutable command input. A Chat or other outer-command handoff without its sole outer receipt is `recovery_required`; recovery never creates a nested Task or Goal receipt. |
| Terminal checkpoint with no initiating-mode closeout writes, but complete request identity, canonical StopReason, evidence, and immutable mode inputs | Execute the original Task or Goal closeout transaction once. A direct command publishes its deterministic receipt; an outer-command handoff requires its already durable outer receipt and publishes no nested receipt. Clear the checkpoint only after that applicable receipt predicate holds. |
| Any partial mode tuple, identity conflict, missing required evidence, or non-canonical StopReason | Preserve the checkpoint as discoverable `recovery_required`; do not repair, clear, or launch work. |
| `preparing` checkpoint without the immutable request trace required for first launch | Preserve the existing fail-closed `recovery_required` compromise; do not rerun Coordinator or launch a replacement. |

Boot performs scheduler and worker-control fencing before this Workspace checkpoint scan. Failure of that fencing remains boot-blocking. A classifier that cannot prove one checkpoint preserves that checkpoint as `recovery_required` and degrades scheduler readiness without blocking unrelated product work; it does not undo successful fencing or prevent the scan from attempting other checkpoints. Online closeout, exact command replay, and boot recovery MUST call the same initiating-mode classifier and owner transaction; they MUST NOT implement three independent transition paths.

The initial terminal mapping is closed and does not depend on an adapter or mode projection:

| StopReason | Durable Turn status | Worker Checkpoint stage | Owning-mode interpretation |
| --- | --- | --- | --- |
| `completed` | `completed` | `completed` | Task or Goal applies its documented completion, review, or next-step predicate. |
| `error` | `failed` | `failed` | Typed worker failure evidence remains authoritative. |
| `aborted` | `cancelled` | `aborted` | The owning mode preserves the intentional stop and applies its documented cancellation or abort result. |
| `length` | `completed` | `completed` | Worker execution ended without success; Task or Goal projects the documented blocked result from terminal evidence. |
| `budget_exhausted` | `completed` | `completed` | Worker execution ended without success; Task or Goal projects the documented blocked result from terminal evidence. |
| `ask_user` | `awaiting_human` | `waiting_for_user` | The exact user-input or approval gate owns the later closeout mapping below. |

Worker-control `status` and its product-safe `stopReason` string are transport facts, not Core StopReason authority. The existing immutable server-scope `worker_control_records` row with `operation=final_status` is the sole accepted-final-status owner; no checkpoint, evidence row, recovery record, or mode projection may replace it. Its record identity is the existing `(agentSessionId, packageSnapshotId, operation, recordKey)` key with `recordKey` equal to the decimal worker sequence. The indexed and parsed row must also match the exact Workspace, Thread, Turn, nullable command request, Agent Session, package snapshot, scheduler lease lineage, sequence, and corresponding canonical terminal event. The row retains raw wire `status`, raw product-safe `stopReason`, diagnostics, evidence-manifest digests, and `acceptedAt`. Exact same-sequence and same-fingerprint replay reuses that row; a changed payload at the sequence conflicts. This server runtime owner survives restart but is not portable Workspace product history.

NanoCore is the sole canonicalization owner and may close a mode only when the raw reason parses as the Core `StopReason` and agrees with this closed canonicalization table:

| Worker-control status | Permitted Core StopReason |
| --- | --- |
| `completed` | `completed` |
| `blocked` | `length`, `budget_exhausted`, or `ask_user` |
| `cancelled` or `interrupted` | `aborted` |
| `failed`, `degraded`, or `lost` | `error` |

An unknown or incompatible pair is retained for inspection and produces `recovery_required`; NanoCore does not guess from Turn status, collapse all non-completed results to `error`, or treat adapter-private text as a new Core reason.

The normal `ask_user -> awaiting_human/waiting_for_user` mapping applies only when the same Turn already owns one exact Core user-input or approval Gate. If an AEP-backed runtime instead submits an accepted raw `status=blocked`, `stopReason=ask_user` final status without such a Gate, NanoCore MUST retain that raw accepted row, finish the existing backend cleanup first, project the exact Product Turn as `interrupted` with error code `worker_human_gate_unavailable`, and project its Agent Session as `interrupted` with the same bounded message. The online worker loop MUST then return `409 recovery_required` without rewriting its request-bound checkpoint: that checkpoint remains `preparing` with `stopReason=null` and `workerSessionId=null`. Scheduler capacity may change from the exact `releasing/worker-final-status` lease to `released` with `recoveryState=needs-evidence` and `releaseReason=worker-human-gate-unavailable` only when the accepted row, cleaned backend session, interrupted Product owners, admission request, and complete lease lineage all agree; any mismatch follows the existing strict failed closeout. Restart applies the same cleanup and interruption projection to the exact accepted row, releases that lease with `recoveryState=needs-evidence` and `releaseReason=scheduler-restart-accepted-final-status`, and lets the post-fencing checkpoint scan preserve the checkpoint and expose `recovery_required`. This is a bounded unavailable-transport fallback, not a remapping of `ask_user`: it creates no Gate, `awaiting_human` state, Gate response action, automatic retry, Session resume, checkpoint state, or recovery workflow.

Gate closeout mapping is exact. An accepted user-input response or granted approval writes its response Item on the same Turn, changes that Turn to `completed`, and changes the checkpoint to `completed`; a denied approval changes the Turn to `cancelled` and checkpoint to `aborted`. Protocol-level `expired`, `withdrawn`, and `superseded` statuses have no accepted G01 closeout producer or decision Item and return `recovery_required` for a worker gate rather than starting a timer or implicit transition. Both accepted branches retain the original `ask_user` evidence. A validation, authorization, or persistence error before the complete response tuple commits leaves the gate and checkpoint waiting; a partial or contradictory durable tuple returns `recovery_required`. None restarts the stopped worker, changes the response into worker output, or invents a third gate-failure terminal branch.

The envelope owns execution reliability after the owning mode service accepts a Coordinator decision. It does not own a second continuation or delegation decision.

There is no separate `prepareNextTurn` semantic authority. The owning Task or Goal service supplies the exact Coordinator-selected worker and structured worker request, plus the Context Package materialized from that request. The envelope may validate, persist, deliver, and checkpoint those values but MUST NOT select another worker or model, rewrite the objective, add context references, or compose a continuation prompt.

`shouldStopAfterTurn(context)` returns a `StopAfterTurnDecision` whose `outcome` is exactly `continue`, `review`, `ask_user`, `block`, `abort`, or `complete`, whose `shouldStop` is false only for `continue`, and whose separate `stopReason` uses the protocol `StopReason` enum.

Runtime-owned system steering such as a budget wrap-up or recovery constraint is input to the owning mode service's next Coordinator decision; the envelope must not inject it behind that decision. User input has no generic follow-up queue in this contract and may enter worker context only through the exact S16 Goal pending owner and immutable delivery proof.

NanoCore's app-local `runWorkerTurnLoop()` is the first worker-turn envelope shell. It receives the mode-owned request identity and prepared worker inputs, atomically invokes the mode's exact Turn reservation, records its allowed launch PermissionDecision, writes the request-bound `preparing` checkpoint, performs the first scheduler admission, starts exactly that worker with exactly that request, observes the terminal worker stop reason, records terminal checkpoint evidence, and evaluates `shouldStopAfterTurn()`. It MUST NOT invent another Turn or checkpoint when the mode-owned launch fence is missing or contradictory. Until S16's immutable Context Package trace exists, a restart or handled failure after the `preparing` fence but before the exact Turn-owned request is durable fails closed as `recovery_required`; this bounded compromise is safer than reconstructing request bytes from Coordinator, checkpoint diagnostics, or current context.

When the owning scheduler lease is `awaiting-reconnect`, the envelope keeps the existing checkpoint nonterminal and must not start another worker, create another checkpoint, or enqueue a replacement continuation. After exact process-key, lineage, and next-sequence adoption of that same lease, the envelope resumes terminal observation and handoff for the same turn. Failure of the restart scan's durable eligibility checks enters existing cleanup before a reconnect window is armed, while an invalid reconnect request is merely rejected and leaves an already armed window intact; only deadline ownership followed by complete cleanup may enter interrupted-checkpoint recovery.

An interrupted-worker retry is available only after the scheduler and worker-control owners have durably rejected exact adoption, completed cleanup, released capacity, and projected the original execution as interrupted. A timeout compare-and-set that merely changes the lease from `awaiting-reconnect` to `needs-evidence` owns cleanup but does not authorize retry. A wrong reconnect key, lineage, sequence, or expired request is rejected without ending the original reconnect window; only successful exact adoption or the scheduler's deadline compare-and-set may win that race.

### Interrupted Retry Eligibility

The following predicate is the only authority for projecting an interrupted-worker recovery row and accepting its retry command. It is derived from existing records and MUST NOT be persisted as another recovery state.

| Required fact | Authoritative record and criterion |
| --- | --- |
| Original attempt | The exact request-bound checkpoint exists at `preparing` or `running_worker` with no terminal StopReason; a completed, failed, aborted, or gate-owned checkpoint is not retry authority. |
| Product outcome | The exact original Turn and its recorded Agent Session are durably `interrupted`; retry never rewrites a running, completed, cancelled, or failed owner into interruption. |
| Scheduler closeout | Exactly one lease matches the Workspace, Thread, Turn, and recorded Agent Session lineage; that lease is terminal `released`, has no reconnect recovery state, and has release reason `scheduler-restart-backend-cleanup`, thereby proving the same atomic terminal transition released capacity. |
| Backend and worker-control closeout | The scheduler terminal transition has already proven the anchored backend session `cleaned` or proven that no backend was anchored; terminal lease status also makes the old token binding non-live. No additional backend-clean or retry-eligibility record is created. |
| Goal continuation, when present | Both checkpoint Goal and Task ids are present, the exact Goal is `running` with that Task as `currentTaskId`, and that exact Task is `running`. A missing half-lineage or contradictory Goal tuple permits inspection but not retry. |
| Task continuation | A checkpoint with neither Goal nor Goal Task lineage may close as an interrupted Task attempt; replacement execution remains a separate `task.start` command. |

An interrupted-worker recovery row exists only when the original-attempt, product-outcome, scheduler-closeout, and backend-closeout facts above all hold. Its `retry` choice and Action Center action exist only when the applicable Goal or Task continuation fact also holds. A checkpoint alone, an ordinary live lease, an adopted lease, `awaiting-reconnect`, `needs-evidence`, incomplete cleanup, or a nonterminal Turn produces no interrupted-worker row and cannot abort a worker or admit a replacement.

The accepted recovery command is `worker.recovery.retry`, scoped by authenticated actor, Workspace, Thread, original Turn, and a strict `{ requestId }` body with no semantic options. Its stable response is `{ outcome: "released_for_retry", turnId }`; the command receipt stores only that Turn resource identity and does not copy the mutable Turn, Goal, Task, lease, Session, or checkpoint projection. The command never changes the already interrupted Turn, lease, Session, backend, or capacity and never creates an admission or starts a worker. For Goal Mode, one Workspace transaction changes the checkpoint from `preparing` or `running_worker` to `aborted`, changes the exact running Goal Task to `ready`, leaves the Goal `running` with `currentTaskId=null`, and writes the command receipt. Task Mode writes only the checkpoint terminalization and receipt in that transaction. The receipt precedes checkpoint-row deletion; fresh execution and exact replay both invoke the existing terminal-checkpoint cleanup, so a cleanup failure leaves one aborted checkpoint and receipt for replay rather than creating a settlement workflow.

Identical replay returns the same stable result without repeating business mutation. `awaiting-reconnect` returns `409 worker_reconnect_pending` with zero writes; a live or successfully adopted attempt is `stale`; incomplete cleanup or contradictory lineage returns `recovery_required`; malformed input is invalid; and a conflicting request identity returns `idempotency_key_conflict`. NanoCore implements this contract through the existing scheduler lease, Turn, Session, checkpoint, Goal, Task, Workspace transaction, command receipt, and terminal-checkpoint cleanup owners; it adds no retry state, settlement workflow, replacement launch, or compatibility path.

The product-facing Goal Mode command is `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/step`. The Goal service obtains one Coordinator decision, persists and materializes its request, runs exactly one bounded worker envelope iteration, then applies the Goal-level stop decision through the Goal owners. The deterministic supervise flow lives under `/goal/test/supervise/step` and is limited to tests, smoke fixtures, and local demos.

### Runtime Checkpoint

NanoCore should persist a runtime checkpoint before non-idempotent or long-running boundaries.

The first checkpoint shape should be app-local.

```ts
interface WorkerCheckpointRecord {
  checkpointId: string;
  workspaceId: string;
  threadId: string;
  turnId: string;
  goalId: string | null;
  taskId: string | null;
  requestId: string;
  requestInputHash: string;
  stage: WorkerTurnStage;
  iteration: number;
  workerSessionId: string | null;
  contextDigest: string | null;
  stopReason: StopReason | null;
  diagnosticsSummary: string | null;
  replayInstruction: false;
  createdAt: string;
  updatedAt: string;
}
```

`requestId` and `requestInputHash` are required on every checkpoint because this envelope is limited to accepted Task or Goal worker commands. `(goalId, taskId)` MUST be either `(null, null)` for Task Mode or two non-null matching Goal Mode identifiers; a half-null pair is invalid and returns `recovery_required`. Any future checkpointed system operation requires its own accepted design and must not reuse this envelope through nullable command identity. These fields bind partial-failure inspection to the original command without storing the prompt or full request.

The checkpoint is not a promise that in-flight streams can resume.

It is a recovery record that tells NanoCore where the turn stopped and what can safely happen next. Same-worker reconnect reattaches terminal observation to the surviving execution; it does not replay worker launch or claim arbitrary stream resumption.

On restart, a checkpoint whose exact lease is `awaiting-reconnect` remains at `running_worker`. Exact adoption continues the same checkpoint, Agent Session, Turn, and worker; verification failure, timeout, cancellation, or cleanup fencing materializes the existing interrupted Item or state update into the Thread.

Only after the interrupted path is selected may the user or Coordinator choose the exact recovery actions authorized here: release a Goal Task for a later retry, start an ordinary new Task request, review partial Artifacts, or request guidance. No retry or replacement is offered while the bounded exact-adoption window remains open, and this specification adds no generic abort action.

An accepted final status after adoption drives the existing checkpoint, terminal evidence, product Turn, Agent Session, workspace-reconciliation, backend-cleanup, lease, and capacity owners directly. Task Mode may clear its checkpoint only after the terminal Turn, stop reason, evidence, required Artifact or Workspace review and handoff records, command receipt when applicable, Session, backend, lease, and capacity closeout are durable. Goal Mode requires that same tuple plus the matching Goal, Goal Task, and nullable Goal Review transition. An `ask_user` outcome backed by an exact Core Gate is acknowledged through that gate tuple but keeps the checkpoint at `waiting_for_user` until the gate owner closes the original envelope; an accepted raw `ask_user` without an exact Gate uses only the bounded unavailable-transport fallback above. Read models, serialized responses, and events are rebuildable projections and are never checkpoint-clear authority. A caller-supplied terminal label is not evidence and cannot clear or overwrite a checkpoint. No settlement coordinator or parallel domain record exists.

Durable checkpoint, terminal, evidence, and business-owner writes replay exactly. Read models and app-local Turn events are rebuildable projections; events may be delivered at least once if a second crash lands between durable closeout and event projection, and consumers must tolerate an equivalent duplicate event.

### Pending User Turn

NanoCore MAY preserve input submitted while work is active only when the owning Goal path can durably prove its original Goal and Turn lineage and later delivery through the contract in `docs/specs/20260713-work_resource_interaction_model.md`. The grounded Item plus Thread-unique `PendingUserTurnRecord` is the implemented sole queued owner until an accepted Context Package proves application, or an exact follow-up or cancellation command preserves and closes the same input. Generic active-turn queues, worker-filesystem mutation, and recovery workflows remain prohibited.

The generic direct-Turn path has no later-delivery owner and MUST return `409 thread_busy` before creating an Item, pending row, or accepted command. Restart reconstructs only accepted Goal pending input from its named durable owners; it MUST NOT infer pending input from audit events, a current Thread projection, or worker-private state.

### Context Compaction

Autonomous context compaction is not authorized by this reliability contract. It requires a separately accepted design with an exact source, output, provenance, failure, replay, and user-visibility owner.

## Data And Protocol Changes

Protocol changes:

- Maintain `StopReason` in `packages/protocol`.
- Maintain stop reasons and terminal stream behavior in `docs/core/protocol.md`.
- Maintain generated JSON Schema and protocol tests for the enum.
- Ensure terminal SSE events continue to carry the stop reason consistently.

NanoCore app-local changes:

- Keep one direct, stateless Quick Chat executor over the existing provider resolver and dispatcher.
- Remove the unused generic internal-agent runner, registry, private event loop, hook framework, tool allowlists, streaming facade, and diagnostics branch.
- Add app-local checkpoint storage for worker turns.
- Reuse the app-local runtime checkpoint and terminal evidence records directly for restart adoption and terminal handoff; add no restart coordinator or closeout workflow.
- Add context package projection records for worker turns.
- Keep one app-local `runWorkerTurnLoop()` shell that accepts a mode-owned Coordinator request and composes validation, delivery, checkpointing, worker start, terminal outcome recording, and stop-after-turn policy without another selection or context-composition stage.
- Normalize Gateway streaming read failures into terminal SSE error payloads with stable stop reasons.

## Alternatives Considered

Alternative: retain the generic internal-agent runner, registry, event loop, hooks, and private streaming facade. Rejected because they have no product consumer, duplicate provider/runtime responsibilities, and authorize a second execution framework for two aggregate calls.

Alternative: require low-level provider stream functions to never throw.

This is too strict for HTTP clients and SDK boundaries; the practical contract belongs at the adapter boundary after the stream starts.

Alternative: encode every error as a final assistant message.

This is too narrow for OpenKit because the thread log has authoritative items and terminal events that do not need to pretend to be assistant prose.

Alternative: implement autonomous context compaction now.

This would mix context-compaction and Knowledge Store policy with worker reliability before there are enough long sessions to validate the compaction behavior.

## Consequences

Quick Chat retains bounded provider invocation, validation, timeout, cancellation, usage attribution, and redacted failure behavior without a private runtime or diagnostics ledger.

Worker and provider terminal semantics remain consistent through the shared stop-reason contract rather than a shared execution framework.

The Web UI can render small truthful runtime states before OpenKit has a larger task graph.

No second internal-role runtime boundary is introduced.

## Testing Strategy

Use the lowest layer that can prove each distinct risk. L1 owns Quick Chat input, projection, timeout, cancellation, provider-error, content-validation, redaction, retry, `StopReason`, and schema behavior. L2 owns accepted worker input, terminal stream records, owner-tuple classification, reconnect fencing, retry eligibility, and rejection of caller-selected terminal state.

L3 retains one deterministic NanoCore kill/restart scenario covering `awaiting-reconnect`, exact same-worker adoption, accepted final status through existing owners, no duplicate worker or checkpoint, and checkpoint clearing. Terminal-checkpoint closeout, timeout cleanup, partial-tuple `recovery_required`, and retry fences remain deterministic L1-L2 concerns and MUST NOT create another restart runner, A1 harness, or cross-product suite.

No test is required for deferred multi-process, multi-target, fairness, hot-failover, snapshot, replacement-worker, settlement, generic internal-agent event, registry, hook, streaming, or diagnostics behavior because those surfaces are outside this accepted design.

## Risks & Mitigations

Risk: stop reasons are too coarse for debugging.

Mitigation: pair the stable enum with app-local redacted error codes and diagnostics.

Risk: context projection hides important information from the model.

Mitigation: record excluded item ids and exclusion reasons in the context package.

Risk: checkpoints create duplicate side effects after restart.

Mitigation: an awaiting-reconnect checkpoint cannot launch or retry work; only exact scheduler and worker-control adoption may continue the same worker, and all terminal owners remain idempotent on their existing lineage.

Risk: a future streaming request recreates a private generic event runtime before a public consumer exists.

Mitigation: require an accepted public contract and reuse the owning provider or App API stream boundary instead of adding a private event vocabulary.

## Resolved Decisions

- `StopReason` belongs on the terminal `turn.completed` event envelope, not on the durable `Turn` record.
- Context package traces are file-system-first workspace records with digests and manifests; SQLite or read-model rows may index or attach them but must not become the only source of truth.
- Quick Chat remains one concrete direct provider function; Workflow Coordinator remains deterministic until an accepted design and real need authorize a provider-backed implementation.
- The minimum interrupted-worker recovery surface is an Item-backed or App API read-model row with checkpoint id, Turn id, stage, context digest, stop reason when known, redacted diagnostics, and only inspect, request-bound retry-after-interruption, review-partial-Artifacts, or request-guidance actions defined by existing owners. Adapter-native resume and a generic recovery abort are not user actions; exact surviving-worker adoption remains automatic under its scheduler and worker-control owners.
- Runtime checkpoints belong to the NanoCore worker-turn loop first; the OpenShell/Codex worker-governance path is the first exercised governed backend, and OpenCode should conform through the same envelope later.
- Restart adoption reuses the existing runtime checkpoint and terminal-handoff owners directly, never replays worker launch, and never creates a replacement session while exact reconnect remains pending. It adds no settlement row.

## Deferred Work

- Define the full file-backed worker context package materialization and replay flow in `docs/specs/20260703-worker_context_package.md`.
- Define autonomous context compaction only after long-running sessions create enough evidence to validate compaction quality and governance.

## Links

- [Communication Model](../core/communication.md)
- [Core Protocol](../core/protocol.md)
- [Git Write Workflow](./20260704-git_write_workflow.md)
