---
status: Accepted
implementation: Partial
kind: concept
aspect: runtime-model
---
# Worker Turn Reliability Envelope

This specification owns the reliability envelope for internal-role Provider calls and worker-turn execution. It owns stop reasons, terminal closeout, item-to-model projection proof, runtime checkpoints, delivery of an accepted worker request, and restart-safe terminal handoff.

## Scope

This specification owns stop-reason closeout, the raw-output Budget, checkpoint stages, failed-start closeout, interrupted retry, and the Git fetch explanation.

It does not own the `StopReason` enum list. [Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md) owns that list.

It does not own scheduling scale or containment procedure. [Runtime Scheduling Scale](20260703-durable_scheduler_design.md#scale-limits) and [Runtime Security](20261109-runtime_security.md) own them.

It does not own context-package materialization or compaction. [Worker Context Package](20260703-worker_context_package.md) and [Agent Runtime Context Compaction](20260902-agent_runtime_context_compaction.md) own them.

It does not own pending input, Goal wake, or live steer. [Pending Requests](20260930-pending_requests.md), [Goal](20261002-goal.md), and [Task Mode Worker Delegation](20260704-task_mode_worker_delegation.md) own them.

It does not own transport adoption proof. [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md) owns that proof.

Core: [Protocol](../core/protocol.md), [Runtime Model](../core/runtime-model.md), [Communication](../core/communication.md), [AgentSession](../core/agent-session.md), [Work Model](../core/work-model.md).

Implementation may break app-local shapes where that gives a cleaner design. Retained records follow the first-stable-release continuity boundary in [Contract Evolution](../core/contract-evolution.md#retained-data-continuity). Before `v0.1.0`, an explicit deployment reset may replace carry-forward. Reset permission never proves an interrupted external effect absent or authorizes its replay. The pre-`v0.1.0` scope follows the engineer's interpretation of NONNEG-001 and COMPAT-001 in [Pre-Stable Data Continuity](../decisions/20261014-pre_stable_data_continuity.md).

### Reliability Posture

This envelope uses the scheduling profile and the one configured RuntimeTarget in [Runtime Scheduling Scale](20260703-durable_scheduler_design.md#scale-limits). Its strict guarantees protect authorization, durable authority, exact lineage, non-duplication of accepted external effects, and truthful terminal projection; they do not promise distributed-system availability or transparent repair of every interrupted write.

When the existing owners cannot prove whether an external effect occurred or cannot derive one unambiguous closeout tuple, `recovery_required`, an explicit interrupted or uncertain outcome, inspection, and a fresh authorized attempt are accepted fallbacks. NanoCore MUST NOT infer success, launch a compatible replacement, synthesize missing authority, or add a settlement workflow merely to hide that interruption.

Possible future multi-process scheduling, multi-writer storage, high availability, hot failover, multiple active targets, or stronger fairness requirements do not authorize present states, abstractions, recovery paths, runners, or test matrices. Any such expansion requires a separately accepted design based on a demonstrated deployment need.

### Containment-Loss Reliability Boundary

Confirmed containment escape and inability to exclude escape are the same strict failure for the affected Runtime Epoch. NanoCore must stop new admissions, external effects, and egress for that NanoHost; revoke route and runtime control handles; interrupt every affected Turn and AgentSession independently; reject publication of output not already accepted behind each durable output barrier; invoke the NanoHost-owned complete-epoch invalidation boundary; and retain only redacted audit and runtime evidence. Potentially exposed Vault material follows the existing revocation or rotation owner. No single-process or sandbox-only cleanup, old-epoch reuse, automatic replay, or replacement execution is permitted. After cleanup, the only product paths are inspection or a fresh authorized request, and capacity remains unavailable until a fresh Runtime Epoch passes readiness and absence-of-prior-state proof.

This boundary applies when containment loss is confirmed by an existing trusted observation or cannot be excluded from existing evidence. It does not claim that NanoCore currently detects escape automatically and adds no incident-response state, settlement record, recovery workflow, runner, or harness.

## Accepted Design

### Layer Ownership

The design has three ownership layers.

`packages/protocol` owns stable stop reasons and terminal stream semantics.

`apps/nanocore` owns concrete Internal Core Role services, worker-turn checkpoints, context packages, and worker adapter orchestration.

Worker adapters own runtime-native details such as Codex session ids, OpenCode session ids, provider request ids, tool-call ids, sandbox commands, and process handles. OpenCode uses this same envelope. This specification does not claim a separate real-host qualification.

## Durable Git Fetch Failure Explanation

A pre-native Git fetch failure MAY carry a closed product-safe `explanation` in the existing startup refusal and durable Turn error. The normalized fields are `code` (`git_fetch_failed`, `git_fetch_tls_failed`, `git_fetch_transport_failed`, or `git_fetch_http_refused`), `stage=workspace_materialization`, `operation=git.fetch`, `dependency=git_remote`, `producer=worker-shim`, producer `observedAt` (exact 24-character UTC ISO timestamp with millisecond precision), `basis=direct_observation`, subprocess outcome (`exit`, `signal`, `spawn`, `timeout`), observed `httpStatus` (401, 403 or null), `enforcement=unavailable`, and strict `evidence` containing `availability=partial` and `outputTruncated`. These are observations of the terminal fetch attempt, not inferred causes of previous attempts. Local object checks retain their existing reasons and do not impersonate failed remote fetches.

`git_fetch_http_refused` requires a completed nonzero fetch with Git's observed HTTP 401 or 403 refusal phrase; only that code permits a non-null HTTP status. TLS and generic completed failures require `exit`; transport failures may also report signal, spawn or timeout. The outer startup stage/reason MUST match the explanation. Unknown properties and contradictory combinations MUST be rejected before persistence. The normalized object contains no arbitrary text, URL, path, secret, private handle or configurable details bag. Fixed safe guidance remains in the existing message and is bounded to 1 KiB for this failure path; the normalized explanation is bounded structurally below 16 KiB and 32 observations. A bounded private stderr prefix never becomes durable text; truncation remains explicit and cannot delay fencing or cleanup.

At acceptance, the exact authenticated Harness operation validates request, AEP, AgentSession and backend lineage. Its receipt is a latest-operation slot, not historical storage: a subsequent operation such as session close may replace it. The public explanation does not duplicate restricted lineage; existing Turn/Thread/Workspace scope and source authorization still govern disclosure. Core persists the validated result before acknowledgement under the existing transport owner, carries the normalized explanation through execution/cleanup aggregation, and retains it in Turn reads, lists and terminal events after restart. This path uses the existing `turn.completed` event carrying the Turn error and introduces no new error Item family. Idempotent terminal repair preserves the first durable explanation. A crash after refusal acceptance but before Turn persistence may lose the explanation, including when cleanup has replaced the latest receipt; restart then reports unavailable cause under existing recovery rather than reconstructing it. Durable Turn, AEP and backend records retain their existing lineage, without a promise that a historical Harness receipt remains queryable. Cleanup uncertainty remains independently represented and never becomes successful cleanup merely because a cause is known. No failure table, journal, telemetry dependency or additional replay path is introduced.

When first work-slot initialization fails during `session.open`, its startup refusal uses this same explanation contract. NanoCore validates the refusal against the exact open operation, the already admitted initial AEP, and that AEP's initiating Turn lineage, and carries the accepted explanation through the existing execution/cleanup aggregation into that Turn's error. This does not dispatch `turn.start`, create another Turn, rerun materialization, or add a diagnostic record or replay path. The existing missing-observation, crash-loss, redaction, and cleanup-uncertainty rules remain unchanged.

An HTTP refusal alone MUST NOT become `sandbox_network_denied`, a Vault failure or a drift finding. That future attribution requires trusted enforcement evidence correlated to the exact attempt and active policy identity; the worker explanation in this contract cannot carry it. No received observation means cause unavailable, never invented producer facts. Later diagnosis does not rewrite historical results. Retain existing unknown/interrupted outcomes when delivery fails, and do not rerun Git to recover diagnostics.

Recovery guidance for HTTP refusal states that the source is not established and asks an authorized operator to inspect sandbox network policy and upstream access separately. Host repository readiness proves only the local checkout. Preserve the failed Turn and retained/incomplete slot; a new Task requires current authorization and existing cleanup/storage admission. Do not disable TLS, inject credentials into credential-free materialization, automatically widen grants or replay the failed operation.

### Stop Reason Contract

Provider streams, worker adapter streams, and gateway streams share the protocol `StopReason` set. `StopReasonSchema` in [Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md#canonical-enums) is that inventory. A terminal `turn.completed` event carries `stopReason`. The durable Turn record does not.

`completed` means the turn reached a normal terminal state; it does not establish achievement of the user's objective. Explicit native output or context limit evidence MUST NOT become `completed` success.

`error` means the runtime failed after accepting or starting the operation.

`aborted` means the operation stopped in response to an OpenKit interrupt or cancellation request for that exact Turn, including a user interrupt, scheduler deadline or cancellation, or another OpenKit control request. Native interruption alone does not establish that request or identify a user actor. A native interrupted, cancelled, or aborted outcome without that OpenKit request is `error`, with a bounded product-safe diagnostic that the Worker runtime stopped on its own. The reason for this distinction is recorded in [Truthful Native Stop Classification](../decisions/20261009-truthful_native_stop_classification.md).

`length` means the model or runtime stopped because positively correlated native evidence proves an output or context limit was reached. A native reason label or diagnostic text alone is not that proof. Unsupported or ambiguous native limits retain `error` or the existing uncertainty and fencing result; they do not imply `budget_exhausted`.

`budget_exhausted` means the thread or turn budget is exhausted and no new substantive work should start.

Worker stop reasons are limited to the five values above. A user-input or approval request is a pending request, as [Pending Requests](20260930-pending_requests.md) defines, and the raising Turn stays running. [Goal](20261002-goal.md#coordinator-role) admits ordinary Tasks through this same envelope.

Low-level provider clients may still throw.

The stream adapter boundary must catch provider, parser, timeout, and adapter errors after the stream starts and encode them as a terminal event or terminal item with a redacted `errorCode` and `errorMessage`.

Before a stream starts, HTTP validation and auth failures may still use normal HTTP errors.

After a stream starts, the caller should see a well-formed terminal record, never a half-open stream that dies without a stop reason.

NanoCore's LLM Gateway wraps Chat Completions and Responses SSE streams at the route boundary. If a provider or bridge stream throws after the public response commits under [the Gateway owner](20260526-llm_gateway_responses_api.md#commit-boundary-and-retry), the wrapper appends a redacted OpenAI-compatible SSE error payload with `stopReason: "error"` and then emits `[DONE]`.

### Worker Raw-Output Accounting

The [large-file decision](../decisions/20261015-large_files_and_model_context.md) separates raw model output from file and context capacity. The current default bound is 16,777,216 bytes per Turn. The aggregate is exhausted only when it crosses that bound. An equal aggregate remains admitted. Count UTF-8 bytes of emitted content fields: intermediate/final text, generated tool-call argument text, and stored exposed reasoning. Exclude transport framing, escaping overhead, duplicate final snapshots, tool results, uploads, and program-produced file bytes. Do not acquire hidden reasoning for metering.

The measuring producer is the native content observer. It keeps one Turn aggregate. The private extension `openkit.worker/rawOutput` on each Worker inference CapabilityCall holds byte length, coverage of `pending`, `complete`, or `unavailable`, and hashed per-source positions. The admitted private contract owns that retained shape. Trusted provider-attempt and content-part byte positions deduplicate prefix and final replay. Identical text from a new attempt or child still counts. Acknowledged source watermarks, per-call sums, and coverage survive restart in the canonical call extension. The aggregate is reread from those records. It is not a retained checkpoint counter. In-memory coalescing and provisional totals are not restart authority. Forwarding waits for immutable covering acknowledgements. A crossing forces every active call cover before the stop request. This contract does not require a commit of every transient callback. A missing, corrupt, or oversize proof is unavailable coverage and recovery, not numeric exhaustion. No checkpoint, separate ledger, or per-call allowance owns this bound. Checkpoint cleanup and outcome-delivery Turns preserve the same proof. Canonical ledger export retains the private namespace and does not expose it in live protocol projections. Retained calls without proof remain unknown.

Native observation runs before stock parsing, conversion and retry discard. Public response completion does not prove source settlement. A call can seal complete coverage only after every reached native source settles and supplies the required pre-conversion hook. If cancellation or failure returns earlier, persist unavailable coverage before public terminalization; late fields or terminal snapshots cannot repair it. Running inference delays a first final. Unknown, missing, corrupt or unavailable coverage refuses a completed final and new substantive inference. Missing proof does not create a zero counter or a budget-exhausted claim.

Crossing the bound commits the measured position before stopping all same-Turn inference and requesting native stop through the existing execution attempt. Only accepted native final evidence permits canonical budget_exhausted. The exact attempt's durable cause maps the accepted native cancellation to budget_exhausted or error; user cancellation retains aborted when its compare-and-set won. Online and restart closeout use the same mapping. Failed or unproved stop remains fenced and uncertain under the existing native recovery owner. Numeric accounting alone proves no native stop or child coverage.


Meter before truncation or conversion to a file. A generated file body in arguments consumes capacity when emitted; its disk copy adds no charge. Generated code that produces a large file consumes only its emitted code/arguments. A newly generated parent summary counts; mechanical forwarding of child output does not.

One atomic aggregate covers the primary, concurrent children, and all observed provider attempts in this Turn. Deduplicate only by trusted attempt, emission/content-part identity, and stream position. Identical text in a new attempt counts again. Observe failed-attempt output before Gateway retry buffering can discard it. Unobserved billed generation belongs to cost accounting.

Persist aggregate and deduplication evidence through the existing Turn execution/recovery authority before acknowledging accounted progress. Adoption, reconnect, retry, and restart cannot reset acknowledged proof or count a replay twice. Missing or contradictory recovery evidence fails closed under the existing recovery rules. This adds no separate accounting lifecycle or repair runner.

At exhaustion, prevent further substantive work and execution of incomplete over-limit tool arguments. After proved stop, use existing `budget_exhausted`, not native `length` or successful completion. Uncertain stop retains existing failure/fencing rules. Preserve files already accepted by their own publication barriers. File storage, capture, parser, transport, context, and time limits remain independent.

Qualification must observe every supported inference and child route, concurrent counter races, new attempts, duplicate snapshots, retry-buffer discard, and restart. An unobservable route cannot claim enforcement; block its dependent execution until it can meet this contract. Resource or privacy failure blocks the affected path rather than unrelated work.

### Direct Internal Core Role Calls

A provider-backed Internal Core Role call MUST be owned by one concrete role assembly over the shared bounded internal Agent runtime rather than a second runner or registry. The role assembly owns its fixed system instruction, bounded input projection, output schema, Tool set, and timeout.

The caller MUST resolve one authorized logical-model contract before invocation. The Assistant uses an explicit admitted logical-model preference when its owning public contract supplies one, then applicable User, Workspace, Internal Role Execution Profile, and Gateway defaults. The Assistant never accepts a Provider profile, provider-native model, account slot, or private route as public input. The selected logical model MUST be currently dispatchable and satisfy the role's required capabilities within the [Gateway-derived coherent logical contract](20260526-llm_gateway_responses_api.md#logical-model-catalog-and-ordered-routing) before any adapter call. A mixed-family contract retains its pinned null family rather than adding a same-family admission requirement. The role assembly MUST reuse the shared internal Agent runtime and Gateway dispatcher, propagate caller cancellation, add the bounded role timeout, validate the returned content, and return or throw without creating private durable state.

The stateless Quick Chat operation is removed. The Assistant uses the shared Internal Agent Loop and Tools. Workflow Coordinator remains a deterministic Core service and MUST NOT be registered or diagnosed as a Provider-backed runner.

Malformed JSON, schema-invalid input, a disallowed logical model, or any caller-supplied private Provider or route selector MUST fail before Gateway dispatch as `invalid_request` or `model_not_allowed` with HTTP 400. An unresolved logical-model fallback MUST fail before dispatch as `chat_mode_not_configured` with HTTP 400 at the owning route. Typed upstream provider errors retain `provider_rate_limited` with HTTP 429 or `provider_request_failed` with the upstream HTTP status, but their public messages are the stable OpenKit messages `Provider rate limit exceeded.` and `Provider request failed.` rather than redacted upstream text. Role timeout returns `provider_call_timeout` with HTTP 504, caller abort returns `provider_call_aborted` with HTTP 499 when the response channel remains writable, and missing or invalid assistant content returns `provider_response_invalid` with HTTP 502. Any other executor failure returns the owning route's `chat_mode_failed` with HTTP 500.

Every public provider error code and message MUST come from the stable OpenKit projection above. Upstream messages, codes, types, response bodies, adapter vocabulary, and stack traces remain private even when redaction would remove known secret markers. No failed invocation may return or persist a `completed` result.

The Assistant branch inherits the unified conversation command-idempotency contract: replay of the same accepted request id returns the original durable lineage without another model call, while a user-requested new attempt uses a new request id. This bounded compromise reuses the command owner and adds no inference settlement workflow.

Provider selection diagnostics, durable CapabilityCall and UsageRecord attribution, audit, and public error projection remain with their existing owners. The role function MUST NOT add a second provider registry, failure ledger, tool executor, hook chain, event protocol, or workflow lifecycle.

A future streaming product need requires an accepted public App API or protocol contract and a real consumer first. Its implementation MUST project the existing provider stream through the owning public route and MUST NOT revive a private parallel event model or unused streaming facade.

### Item To LLM Projection

OpenKit's durable history is an item log.

Provider-visible context is a projection of that log, not the log itself.

The context-package owner records the item-to-model projection. The trace is a workspace file with a digest and a manifest. A database row may index that trace and MUST NOT be its only copy. An exact trace is delivery proof. A missing trace fails closed.

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

The worker-turn envelope is the app-local execution state machine shared by bounded Task delegation, including a Goal-dispatched Task.

The accepted checkpoint stages are exactly:

```text
preparing
running_worker
completed
failed
aborted
```

No checkpoint row represents `idle`; absence of a row is idle. `reviewing` remains with the Goal and Review owners, verification remains an evidence record rather than a Goal or checkpoint lifecycle state, and workspace saving remains with workspace handoff; none may be copied into the worker checkpoint. Reconnect remains the NanoHost adapter's `awaiting-reconnect` observation on the same open attempt while the checkpoint stays `running_worker`; it is not another worker stage.

| Current stage | Permitted next stage | Required predicate |
| --- | --- | --- |
| no row | `preparing` | The owning mode has reserved one exact Turn id and written the request id, input hash, nullable `goalId`, Turn lineage, and allowed worker-launch PermissionDecision into the same Workspace transaction as this checkpoint. `goalId` may name the Goal that authorized a Goal-dispatched Task and may be absent. `taskId` stays absent because a Task has no separate task record. A Goal-dispatched Task checkpoint is an ordinary Task checkpoint. The one-way cutover removes the legacy Goal Task pair; that pair is not this contract. Task Mode has no Goal task record. |
| `preparing` | `running_worker` | The exact reserved Turn is bound to its first scheduler admission, execution attempt, AgentSession, and worker execution lineage. Exact command replay may perform a not-yet-started first launch only when an immutable mode-owned request trace proves the same prepared worker request and Context Package under the reserved identities. Without that trace, a request-bound checkpoint with no complete launch effect returns `recovery_required`; it never reruns Coordinator, reselects context, or launches a replacement. Any half checkpoint/Task pair, duplicate effect, or contradictory lineage also returns `recovery_required`. |
| `preparing` | no row | The initiating mode completes the live attempt-local cancelled-admission exception in [Durable Scheduler Design](20260703-durable_scheduler_design.md#missing-turn-checkpoint-maintenance), including no attempt opened and no submit accepted or unknown. This ends preparation without a worker outcome; otherwise the existing transitions and restart predicates apply. |
| `running_worker` | `completed`, `failed`, or `aborted` | The exact worker Turn and terminal evidence own the matching StopReason, including canonical pre-submission failure evidence under [Failed start before Worker submission](#failed-start-before-worker-submission). A user-input or approval request does not change this stage. It is a pending request, as [Pending Requests](20260930-pending_requests.md) and [Task Mode Worker Delegation](20260704-task_mode_worker_delegation.md) define, and the Turn stays running. |
| `completed`, `failed`, or `aborted` | no further stage | Worker execution is terminal, but the uncleared checkpoint remains discoverable until every durable owner required by the initiating mode, evidence, review, workspace handoff, AgentSession, backend adapter, and execution-attempt contracts completes closeout. |

A queued accepted worker Turn retains its request-bound `preparing` checkpoint and original admission without requiring AgentSession assignment or native submission. Later preparation failure records canonical error evidence on that same Turn and uses the initiating-mode pre-effect closeout proof; missing or contradictory owners remain inspectable and no execution record is fabricated.

Every uncleared checkpoint is a restart candidate, including a terminal-stage checkpoint. A terminal stage proves only that worker execution ended; it does not prove that Task closeout committed. A Goal-dispatched Task uses that ordinary Task closeout. Restart reuses the named owners to finish the already-authorized closeout when their complete tuple is deterministic, otherwise it returns `recovery_required`. It MUST NOT skip a terminal checkpoint, infer workflow completion, or create a settlement owner. Removal of a live invocation's preparation with no attempt opened and no submit accepted or unknown follows only that cancelled-admission exception; it is not worker terminal closeout.

Restart classification is derived from the existing records and is not persisted as another recovery lifecycle:

| Existing durable tuple | Only permitted result |
| --- | --- |
| Open attempt, including adapter-owned `awaiting-reconnect`, or closing attempt without a proved fence | Preserve the current attempt; do not close, retry, replace, or clear its checkpoint. |
| Closing attempt with an accepted final status | Finish generic Turn, AgentSession, evidence, backend handoff, and proved attempt-fence closeout, then invoke the initiating mode's closeout against the same checkpoint. |
| `running_worker` checkpoint with no StopReason, complete agreeing command/input/admission/Turn/AgentSession/finalized-package/backend lineage, and the sole relevant closed `not_accepted` / `turn-start-failed` attempt with no operation, submission deadline, outcome, or fence, satisfying every predicate in [Failed start before Worker submission](#failed-start-before-worker-submission) | The initiating checkpoint owner publishes `error` failure on the original Turn and terminal AgentSession status `failed`, completes the original Task closeout and applicable receipt or source predicate, records the failed checkpoint, and clears it only after the complete applicable evidence predicates hold. Partial publication retries through those same owners without launch or redelivery. |
| Nonterminal checkpoint whose exact Turn and AgentSession are interrupted after scheduler cleanup | Apply only the existing interrupted-worker recovery predicate; no terminal closeout or replacement is inferred. |
| Terminal checkpoint with the complete initiating-mode tuple and command receipt | Validate the complete tuple, then perform only the exact checkpoint cleanup. |
| Terminal checkpoint with the complete request-owned initiating-mode tuple but no command receipt | Only an unambiguous direct `task.start` owner may publish its deterministic missing receipt after validating every tuple member against the checkpoint and immutable command input. A Chat or other outer-command handoff without its sole outer receipt is `recovery_required`; recovery never creates a nested Task or Goal receipt. |
| Terminal checkpoint with no initiating-mode closeout writes, but complete request identity, canonical StopReason, evidence, and immutable mode inputs | Execute the original Task closeout transaction once. A Goal-dispatched Task uses that same closeout. A direct command publishes its deterministic receipt; an outer-command handoff requires its already durable outer receipt and publishes no nested receipt. Clear the checkpoint only after that applicable receipt predicate holds. |
| Any partial mode tuple, identity conflict, missing required evidence, or non-canonical StopReason | Preserve the checkpoint as discoverable `recovery_required`; do not repair, clear, or launch work. |
| `preparing` checkpoint without the immutable request trace required for first launch | Preserve the existing fail-closed `recovery_required` compromise; do not rerun Coordinator or launch a replacement. |

Boot performs scheduler and worker-control fencing before this Workspace checkpoint scan. Failure of that fencing remains boot-blocking. A classifier that cannot prove one checkpoint preserves that checkpoint as `recovery_required` and degrades scheduler readiness without blocking unrelated product work; it does not undo successful fencing or prevent the scan from attempting other checkpoints. Online closeout, exact command replay, and boot recovery MUST call the same initiating-mode classifier and owner transaction; they MUST NOT implement three independent transition paths.

After restart, ordinary post-listener maintenance invokes the existing worker Turn lifecycle owner for a nonterminal Turn whose exact attempt has first terminal cause `turn-start-failed` and whose complete Workspace, Thread, Turn, request/admission, AgentSession when assigned, immutable input, package when finalized, and backend-operation lineage agrees. It requires no checkpoint, accepted final status, competing execution owner, or contradictory binding. Closeout requires that attempt to be closed with exact accepted backend fencing and required handoff, or definite pre-effect non-acceptance proving no backend ownership, heartbeat, worker sequence, process key, or route-token hash. No placement plan, capacity row, or separate backend-anchor state is inferred. The Turn owner records `failed` with `StopReason=error`, closes a non-reusable assigned AgentSession through its owner, and completes existing terminal publications; it declares failure of this Turn, not absence of prior effects. If preparation failed before any attempt or AgentSession was assigned, the Task owner's complete queued pre-effect tuple closes that same accepted Turn without synthetic execution records. Unproved outcome delivery uses `delivery_unknown` and remains `delivery-unknown` under Pending Requests without resubmission; otherwise use `worker_governance_turn_failed`, preserving authoritative typed failure or delivery proof. Missing, stale, unreadable, or contradictory proof remains `recovery_required`. Open/reconnecting or unfenced closing work, checkpoints, and accepted final statuses stay with their existing owners. Unknown cleanup retains exclusion. Failed product writes may finish idempotently through the same maintenance owner, including publication after the terminal write, without reopening a Turn, changing its outcome, creating recovery state, or replaying execution. Completion is the exact terminal Turn, consistent assigned AgentSession and terminal publications, no redelivery, and fresh conversation admission when its independent dependencies permit; unrelated live work remains unchanged. The failure-closeout purpose is recorded in [the earlier decision](../decisions/20261003-terminal_failed_start_turn_recovery.md); the grant predicates are replaced by [the execution-backend decision](../decisions/20261006-execution_backend_port_in_nanocore.md).

The initial terminal mapping is closed and does not depend on an adapter or mode projection:

| StopReason | Durable Turn status | Worker Checkpoint stage | Owning-mode interpretation |
| --- | --- | --- | --- |
| `completed` | `completed` | `completed` | The Task applies its documented completion, review, or next-step predicate. A Goal-dispatched Task uses that ordinary Task predicate. |
| `error` | `failed` | `failed` | Typed worker failure evidence remains authoritative. |
| `aborted` | `interrupted` | `aborted` | The owning mode preserves the intentional stop cause and applies its documented cancellation or abort result. |
| `length` | `completed` | `completed` | Worker execution ended without success; the Task projects the documented blocked result from terminal evidence. A Goal-dispatched Task uses that ordinary Task result. |
| `budget_exhausted` | `completed` | `completed` | Worker execution ended without success; the Task projects the documented blocked result from terminal evidence. A Goal-dispatched Task uses that ordinary Task result. |

Worker-control `status` and its product-safe `stopReason` string are transport facts, not Core StopReason authority. The existing immutable server-scope `worker_control_records` row with `operation=final_status` is the sole accepted-final-status owner; no checkpoint, evidence row, recovery record, or mode projection may replace it. Its record identity is the existing `(agentSessionId, packageSnapshotId, operation, recordKey)` key with `recordKey` equal to the decimal worker sequence. The indexed and parsed row must also match the exact Workspace, Thread, Turn, nullable command request, AgentSession, package snapshot, execution-attempt lineage, sequence, and corresponding canonical terminal event. The row retains raw wire `status`, raw product-safe `stopReason`, diagnostics, evidence-manifest digests, and `acceptedAt`. Exact same-sequence and same-fingerprint replay reuses that row; a changed payload at the sequence conflicts. This server runtime owner survives restart but is not portable Workspace product history.

NanoCore is the sole canonicalization owner. Closeout based on an accepted Worker final status requires the raw reason to parse as the Core `StopReason` and agree with this closed canonicalization table; [Failed start before Worker submission](#failed-start-before-worker-submission) instead derives `error` from its complete canonical pre-submission proof without a Worker final status:

| Worker-control status | Permitted Core StopReason |
| --- | --- |
| `completed` | `completed` |
| `blocked` | `length` or `budget_exhausted` |
| `cancelled` or `interrupted` | `aborted` |
| `failed`, `degraded`, or `lost` | `error` |

The exact durable attempt cause overrides an accepted native cancellation. `turn-cancelled` maps to `aborted`. `raw-output-exhausted` maps to `budget_exhausted`. `raw-output-unavailable` maps to `error`. A user cancellation that won the compare-and-set stays `aborted`. An unproved stop stays fenced and uncertain. The numeric sum alone does not authorize that final mapping.

An unknown or incompatible pair is retained for inspection and produces `recovery_required`; NanoCore does not guess from Turn status, collapse all non-completed results to `error`, or treat adapter-private text as a new Core reason. The [adapter normalization boundary](20260629-worker_runtime_communication_model.md#adapter-normalized-stop-outcomes) carries a proved native output or context limit through existing worker-control `blocked` with `stopReason=length`. The table above then yields a `completed` Turn and checkpoint with StopReason `length` and a blocked Task, never Task success. A native interrupt yields `aborted` only with the exact OpenKit request required by [Stop Reason Contract](#stop-reason-contract); a runtime self-stop yields `failed/error`. Native crashes, process exits, errors, and malformed or missing terminal evidence retain their existing failure, uncertainty, and fencing rules. Cancellation that already won in the authoritative attempt retains its existing precedence over a late native result; diagnostics do not establish cancellation authority.

Human requests do not pause worker execution, suspend the source AgentSession, or introduce a waiting checkpoint stage. A Task worker's approval or user-input request is a pending request: the Turn stays running, and the response is delivered by the next Turn, as [Pending Requests](20260930-pending_requests.md) and [Task Mode Worker Delegation](20260704-task_mode_worker_delegation.md) define. A Goal-dispatched Task is an ordinary worker Turn, as [Goal](20261002-goal.md) defines. An unknown or contradictory terminal tuple stays `recovery_required`. None of these paths restarts a stopped worker, synthesizes a receipt, or creates a settlement workflow. Later work requires a new command and Turn.

The envelope owns execution reliability after the owning mode service accepts a Coordinator decision. It does not own a second continuation or delegation decision. After a stop, continuation is an ordinary new authorized Turn on the same [Task Thread](20260704-task_mode_worker_delegation.md) or a decision by the existing [Goal Coordinator](20261002-goal.md#coordinator-role). Neither route resends the old native prompt or repeats an external effect whose outcome is unknown. This amendment adds no automatic retry, prompt replay, harness restart loop, watchdog, StopReason, durable record, state, or lifecycle. Runtime-native retries within one admitted prompt retain their existing behavior.

There is no separate `prepareNextTurn` semantic authority. The owning Task service supplies the exact Coordinator-selected worker and structured worker request, plus the Context Package materialized from that request, for both standalone and Goal-admitted Tasks. The envelope may validate, persist, deliver, and checkpoint those values but MUST NOT select another worker or model, rewrite the objective, add context references, or compose a continuation prompt.

`shouldStopAfterTurn(context)` returns a `StopAfterTurnDecision` whose `outcome` is exactly `continue`, `review`, `block`, `abort`, or `complete`, whose `shouldStop` is false only for `continue`, and whose separate `stopReason` uses the protocol `StopReason` enum.

Runtime-owned system steering such as a budget wrap-up or recovery constraint is input to the owning mode service's next Coordinator decision; the envelope must not inject it behind that decision. User input has no generic follow-up queue in this contract. Pending Request outcomes arrive on later Turns under [Pending Requests](20260930-pending_requests.md); unsolicited live input uses only [Task live steer](20260704-task_mode_worker_delegation.md#live-steer) and the private Harness contract. Goal-owned steering is not an input on this envelope. [Goal](20261002-goal.md#wake-marker) intent and card edits cause a later Coordinator read and do not steer a running worker.

NanoCore's app-local `runWorkerTurnLoop()` is the first worker-turn envelope shell. It receives the mode-owned request identity and prepared worker inputs, atomically invokes the mode's exact Turn reservation, records its allowed launch PermissionDecision, writes the request-bound `preparing` checkpoint, performs the first scheduler admission, starts exactly that worker with exactly that request, observes the terminal worker stop reason, records terminal checkpoint evidence, and evaluates `shouldStopAfterTurn()`. It MUST NOT invent another Turn or checkpoint when the mode-owned launch fence is missing or contradictory. When the immutable Context Package trace is missing, a restart or a handled failure after the `preparing` fence but before the exact Turn-owned request is durable fails closed as `recovery_required`. It does not reconstruct request bytes from Coordinator output, checkpoint diagnostics, or current context.

When the NanoHost adapter observes the same open attempt as `awaiting-reconnect`, after a transport loss or a NanoCore restart, the envelope keeps the existing checkpoint nonterminal and must not start another worker, create another checkpoint, recreate the sandbox, or enqueue a replacement continuation. After predecessor-fenced NanoHost reconnect and exact process-key, lineage, backend-session, package-snapshot, and next-sequence adoption of that same attempt, the envelope resumes terminal observation and handoff for the same turn. This deployment starts from a new data root and does not read earlier-version data ([decision](../decisions/20260930-earlier_version_data_not_carried.md)). Interruption does not prove that an external effect did not happen. A binding that cannot be proved exactly is closed or fenced, and a successor resumes natively. Failure of the restart scan's durable eligibility checks enters existing cleanup before a reconnect window is armed, while an invalid reconnect request is merely rejected and leaves an already armed window intact; only deadline ownership followed by definite sandbox cleanup or NanoHost-owned epoch invalidation may enter interrupted-checkpoint recovery.

An interrupted-worker retry is available only after the scheduler and worker-control owners have durably rejected exact adoption, the NanoHost has proved definite sandbox cleanup or completed fresh-epoch recovery after invalidation, the exact attempt fence and handoff permit exclusion release, and the original execution is projected as interrupted. A timeout classification from adapter-owned `awaiting-reconnect` to `needs-evidence` transfers the same attempt to closing/cleanup but does not authorize retry or release exclusion. A wrong reconnect key, lineage, sequence, predecessor connection, or expired request is rejected without ending the original reconnect window; only successful exact adoption or the scheduler's deadline compare-and-set may win that race.

#### Failed start before Worker submission

The [engineer decision](../decisions/20261009-checkpoint_owned_failed_start_closeout_and_release_hold.md) records why this narrow alternative remains checkpoint-owned.

The checkpoint owner may finish a failed start before Worker submission when the original accepted command and immutable input, admission, Turn, checkpoint, assigned AgentSession, finalized package, and backend lineage form one complete agreeing tuple. The checkpoint is `running_worker` with no StopReason, and the sole relevant attempt is closed with definite `not_accepted`, first terminal cause `turn-start-failed`, and no operation, submission deadline, outcome, or fence. Earlier busy refusals are excluded only by their existing definite no-effect proof. No live invocation, later or competing execution owner, accepted Worker final status, contradictory terminal publication, native handle or binding, accepted heartbeat or sequence, process identity, route credential evidence, Gate closeout, or pending-outcome delivery ownership may exist. Missing or unreadable evidence is not absence.

The backend adapter must positively prove the unused preparation boundary. For the NanoHost anchored case, the exact preparation anchor is cleaned and has no published package materialization or Workspace handle. Its pending handoff does not require invented output or a fabricated completed handoff. This rule changes no physical cleanup, residency, retained-storage, or exclusion authority. Unproved preparation, any possible outstanding effect, and all other tuples remain with their existing owners as `recovery_required`.

From that proof, the initiating checkpoint owner invokes the existing Turn and AgentSession lifecycle owners to publish failure on the original Turn with `StopReason=error`, the existing failed-start diagnostic unless authoritative failure evidence already exists, and terminal retirement of its non-reusable AgentSession with status `failed`. It then applies the original Task closeout, records the matching failed checkpoint, and clears that checkpoint only when the complete applicable command receipt or source tuple and evidence predicates hold. Native failed-start maintenance continues to exclude checkpoints. No backend operation, fencing record, Worker final status, replacement attempt, or missing outer-command receipt is synthesized.

Execution-generated runtime provenance is inapplicable only when the same complete proof establishes that no Worker was submitted. The original accepted input, existing product history, artifacts, and evidence remain authoritative and are preserved. Partial product publication retries through the same owners without changing a decided outcome, timestamp, diagnostic, or existing event. Restart and exact replay apply the same classification to complete the remaining publication and checkpoint closeout; missing or contradictory owners retain the checkpoint for inspection. Recovery never launches or redelivers work. Observable completion is one failed original Turn, its consistent terminal AgentSession and terminal publications, completion of the applicable receipt predicate, checkpoint removal, and fresh Thread admission when independent dependencies permit.


An original native Worker execution interrupted by restart before allocation may use the same complete command, input, admission, package, Session and checkpoint lineage checks with first terminal cause `restart-before-effects`. This distinct branch requires positive adapter-owned proof of definite non-acceptance: no operation, backend Session, runtime binding, heartbeat, Worker sequence, process key, route-token evidence, competing owner or contradictory Worker-control evidence. It MUST retain its original execution and exactly its original materialize, terminal-publication and release obligations. The existing native terminal owner must acknowledge the original failed Turn, AgentSession and terminal-publication outcome. Only then may the native journal owner cancel the proved unused materialize and release obligations, preserving immutable step identities and any exclusion until every original obligation is resolved without an unknown result. Cancelling an unused release claims no physical release or fence. Checkpoint deletion requires that acknowledged closed original root and the original command receipt and Audit; input and package evidence remains required, while execution-generated provenance is inapplicable only under this complete positive absence proof. Restart resumes those same local transitions, skips their immutable ended outcomes and never submits Worker work. Missing, extra, unknown or contradictory obligations retain recovery ownership.

### Durable Input Ownership

Write exact input through [the work owner](20260921-work_data_retention_format.md#work-owned-input-and-proof) before public acceptance. Freeze any selected batch's member order and digests. Before native contact, open the attempt-bound kernel obligation. Native acceptance is observable intake. Only exact processing read-back establishes consumption. Keep the obligation open until consumption or governed resolution, and record which occurred. If contact may have occurred and proof is lost, keep it unknown and inspect the original operation. Refuse unqualified steer before contact. For a Worker Pending Request, report delivered only after exact read-back. Preserve accepted bytes until consumption or governed resolution. For busy-loop selection, see [Work Model](../core/work-model.md#active-work-semantics).

### Interrupted Retry Eligibility

The following predicate is the only authority for projecting an interrupted-worker recovery row and accepting its retry command. It is derived from existing records and MUST NOT be persisted as another recovery state.

| Required fact | Authoritative record and criterion |
| --- | --- |
| Original attempt | The exact request-bound checkpoint exists at `preparing` or `running_worker` with no terminal StopReason; a completed, failed, aborted, or gate-owned checkpoint is not retry authority. |
| Product outcome | The exact original Turn and its recorded AgentSession are durably `interrupted`; retry never rewrites a running, completed, or failed owner into interruption. |
| Scheduler closeout | Exactly one original execution attempt matches the Workspace, Thread, Turn, recorded AgentSession, and interrupted worker lineage. Any preceding busy attempts are closed with definite non-acceptance and no effects; no competing unresolved attempt exists. The original execution attempt is `closed`, exact adoption has been durably rejected, and its accepted fence and completed handoff prove the restart-cleanup transition released exclusion. Open, unknown, closing, or reconnecting ownership is not retry authority. |
| Backend and worker-control closeout | The same attempt proves exact backend cleanup/fencing, or definite non-acceptance with no possible outstanding operation. Its closed/revoked authority makes old Turn route bindings non-live. Required Workspace handoff is complete. No additional backend-clean, capacity, or retry-eligibility record is created. |
| Goal continuation, when present | A Goal-dispatched Task uses the ordinary Task continuation below. A Goal task record or a legacy Goal and Task id pair is not retry authority. A missing deleted Goal is known absence. A contradictory non-Goal owner permits inspection but not retry. |
| Task continuation | A checkpoint with no Goal id may close as an interrupted Task attempt; replacement execution remains a separate `task.start` command. A Goal-dispatched Task uses that same closeout. |

An interrupted-worker recovery row exists only when the original-attempt, product-outcome, scheduler-closeout, and backend-closeout facts above all hold. Its `retry` choice and Action Center action exist only when the applicable Goal or Task continuation fact also holds. A checkpoint alone, an ordinary open attempt, an adopted attempt, `awaiting-reconnect`, `needs-evidence`, incomplete cleanup, or a nonterminal Turn produces no interrupted-worker row and cannot abort a worker or admit a replacement.

The canonical public recovery operation is `recovery.checkpoint-retry` under [Operation Definition](20261002-operation_definition.md). It is scoped by authenticated actor, Workspace, Thread, and original Turn. Its strict flat input contains `workspaceId`, `threadId`, `turnId`, and `requestId`, with no semantic options. Its stable response is `{ outcome: "released_for_retry", turnId }`; the command receipt stores only that Turn resource identity and does not copy the mutable Turn, Goal, Task, attempt, AgentSession, or checkpoint projection. The command never changes the already interrupted Turn, attempt, AgentSession, or backend residency and never creates an admission or starts a worker. A Goal-dispatched Task uses that same checkpoint terminalization and receipt. It does not update a Goal task record. Task Mode writes only the checkpoint terminalization and receipt in that transaction. The receipt precedes checkpoint-row deletion; fresh execution and exact replay both invoke the existing terminal-checkpoint cleanup, so a cleanup failure leaves one aborted checkpoint and receipt for replay rather than creating a settlement workflow.

Identical replay returns the same stable result without repeating business mutation. `awaiting-reconnect` returns `409 worker_reconnect_pending` with zero writes; a live or successfully adopted attempt is `stale`; incomplete cleanup or contradictory lineage returns `recovery_required`; malformed input is invalid; and a conflicting request identity returns `idempotency_key_conflict`. NanoCore implements this contract through the existing execution attempt, Turn, AgentSession, checkpoint, Goal, Task, Workspace transaction, command receipt, and terminal-checkpoint cleanup owners; it adds no retry state, settlement workflow, replacement launch, or compatibility path.

A Goal-dispatched Task is an ordinary worker Turn on this envelope. This envelope adds no separate Goal command.

### Runtime Checkpoint

NanoCore persists an app-local runtime checkpoint before a non-idempotent or long-running boundary. The retained record is `WorkerCheckpointRecord` in `apps/nanocore/src/runtime/worker-checkpoints.ts`. The accepted stages remain the five stages named above. That artifact also admits `waiting_for_user`. Linking the artifact does not add that stage to this contract. The extra stored value remains [#726](https://github.com/lingkaix/openkit/issues/726).

`requestId` and `requestInputHash` are required on every checkpoint because this envelope is limited to accepted worker commands, including a Goal-dispatched Task. `goalId` may name the Goal that authorized that Task and may be absent. `taskId` stays absent because a Task has no separate task record. A non-null `taskId` is not this contract. A missing Goal removed by the accepted deletion is known absence, not `recovery_required`. A contradictory non-Goal owner still returns `recovery_required`. Any future checkpointed system operation requires its own accepted design and must not reuse this envelope through nullable command identity. These fields bind partial-failure inspection to the original command without storing the prompt or full request.

The checkpoint is not a promise that in-flight streams can resume.

It is a recovery record that tells NanoCore where the turn stopped and what can safely happen next. Same-worker reconnect, after a transport loss or a NanoCore restart, reattaches terminal observation to the surviving execution; it does not replay worker launch or claim arbitrary stream resumption.

After a transport loss or a NanoCore restart, a checkpoint whose exact open attempt has adapter-owned `awaiting-reconnect` remains at `running_worker`. Exact adoption continues the same checkpoint, AgentSession, Turn, and worker; verification failure, timeout, cancellation, or cleanup fencing materializes the existing interrupted Item or state update into the Thread. A binding that cannot be proved exactly is closed or fenced, and a successor resumes natively.

The interrupted-worker read model carries the checkpoint id, Turn id, stage, context digest, stop reason when known, and redacted diagnostics. Only after the interrupted path is selected may the user or Coordinator choose the exact recovery actions authorized here: inspect, start an ordinary new Task request, review partial Artifacts, or request guidance. No retry or replacement is offered while the bounded exact-adoption window remains open, and this specification adds no generic abort action. User-facing recovery has no user-operated native-resume control. Successor resume is runtime behavior.

An accepted final status after adoption drives the existing checkpoint, terminal evidence, product Turn, AgentSession, workspace-reconciliation, backend cleanup and execution-attempt owners directly. Task Mode may clear its checkpoint only after the terminal Turn, stop reason, evidence, required Artifact or Workspace review and handoff records, command receipt when applicable, AgentSession when assigned, backend handoff/fence, and execution-attempt closeout are durable, with final-status, fencing, handoff, and execution-generated runtime-provenance applicability qualified only by [Failed start before Worker submission](#failed-start-before-worker-submission). A Goal-dispatched Task uses that same Task closeout tuple. A Goal task record and a Goal Review transition are not this contract. The one-way cutover removes that legacy tuple. A user-input or approval request does not hold the checkpoint at a waiting stage. It is a pending request, as [Pending Requests](20260930-pending_requests.md) defines. Read models, serialized responses, and events are rebuildable projections and are never checkpoint-clear authority. A caller-supplied terminal label is not evidence and cannot clear or overwrite a checkpoint. No settlement coordinator or parallel domain record exists.

Durable checkpoint, terminal, evidence, and business-owner writes replay exactly. Read models and app-local Turn events are rebuildable projections; events may be delivered at least once if a second crash lands between durable closeout and event projection, and consumers must tolerate an equivalent duplicate event.

The terminal-checkpoint runtime CapabilityCall derives `cap` UUIDv5 from exact JSON name `["runtime", checkpointId]`. Use the exact durable checkpoint identity and literal runtime purpose. Admit it only at existing terminal accounting. Preserve its attribution, timestamp and result across exact replay and reopen ([accepted allocation decision](../decisions/20261016-identifier_derivation_and_import_allocations.md)). Worker launch, terminal acceptance, closeout and retention remain unchanged. Missing or contradictory checkpoint authority retains the existing failure.

Its `sandbox_sessions` measurement uses the [Capability Usage recorder](20260703-audit_usage_evidence_records.md#call-and-usage-identity)'s independent `use` UUIDv7 default and full equivalence lookup. Reuse the stored measurement ID for the same call, category `runtime`, unit `sandbox_sessions`, quantity 1 and source `worker-checkpoint-terminal`. Preserve the existing model, provider and `sourceIds` attribution. No usage derivation is declared. The call ID cannot replace attribution checks or prove an unknown effect. Retention and lifecycle stay with the checkpoint, call and usage owners. Acceptance requires one retained call and equivalent measurement under terminal replay and reopen, without another launch or synthesized completion.

### Pending User Turn

A Task worker's requested input is a pending request with later-Turn outcome delivery, as [Pending Requests](20260930-pending_requests.md) defines. Unsolicited input to exact running work uses only [Task live steer](20260704-task_mode_worker_delegation.md#live-steer) through [Worker Control Protocol](20260703-worker_control_protocol.md#harness-control-operations), never a Goal steering record. It adds no pending-user-turn queue, checkpoint transition, continuation, or recovery runner. Dispatched unknown effects retain existing fencing; original Task closeout remains authoritative. Generic active-turn queues, worker-filesystem mutation, and recovery workflows remain prohibited.

The generic direct-Turn path, outside explicit [Task live steer](20260704-task_mode_worker_delegation.md#live-steer), has no later-delivery owner and MUST return `409 thread_busy` before creating an Item, pending row, or accepted command. Restart MUST NOT infer pending input from audit events, a current Thread projection, or worker-private state.

### Inactive Goal Input Contract

A Goal work-intent edit is recorded on the Goal and does not change a running worker. Restart does not reconstruct a Goal steering row. Generic active-turn queues, worker-filesystem mutation, and recovery workflows remain prohibited.

Restart does not reconstruct a Goal steering row. A missing deleted Goal is known absence. Restart MUST NOT infer pending input from audit events, a current Thread projection, or worker-private state.

A Goal-dispatched Task is an ordinary worker Turn. This envelope adds no separate Goal path. [Goal](20261002-goal.md#wake-marker) owns implemented intent and card edits and later Coordinator admission; those edits do not supply live input to the worker envelope.

### Context Compaction

This reliability contract does not authorize or prohibit context compaction. `docs/specs/20260902-agent_runtime_context_compaction.md` separately owns its exact source, output, provenance, failure, replay, restart, user visibility, and selection of one compaction authority per execution.


## Acceptance

Use the lowest layer that can prove each distinct risk. L1 owns input, projection, timeout, cancellation, provider-error, content-validation, redaction, retry, `StopReason`, and schema behavior. L2 owns accepted worker input, terminal stream records, owner-tuple classification, reconnect fencing, retry eligibility, and rejection of caller-selected terminal state.

Stop-classification acceptance proves that correlated OpenCode idle success with assistant finish `length`, Pi native `length` without an OpenKit interrupt request, and DeepSeek `max_tokens` each produce worker-control `blocked/length`, a `completed` Turn with terminal StopReason `length`, a `completed` checkpoint eligible for cleanup only after the existing complete closeout proof, and a blocked Task. Native self-interruption without an OpenKit request produces `failed/error` with a bounded actor-neutral diagnostic. A correlated native interrupt after that request preserves `aborted`. DeepSeek `max_turn_requests` and `refusal`, ambiguous Codex limits, malformed or missing terminal evidence, cancellation races, and unknown cleanup retain their documented failure or uncertainty results. These paths launch zero automatic successor Turns and preserve unknown external effects for inspection. Adapter-local proof and the shared Harness-to-Core closeout proof are separate obligations.

L3 retains one deterministic NanoCore kill/restart scenario covering `awaiting-reconnect` after a transport loss or a NanoCore restart, predecessor-fenced exact same-worker and same-sandbox adoption in either case, and, when proof fails, a binding that is closed or fenced with a successor resuming natively, accepted final status through existing owners, no duplicate worker or checkpoint, exact next sequence, and checkpoint clearing. Terminal-checkpoint closeout, timeout cleanup, partial-tuple `recovery_required`, and retry fences remain deterministic L1-L2 concerns and MUST NOT create another restart runner, A1 harness, or cross-product suite.

No test is required for deferred multi-process, multi-target, fairness, hot-failover, snapshot, replacement-worker, settlement, generic internal-agent event, registry, hook, streaming, or diagnostics behavior because those surfaces are outside this accepted design.

## Implementation

- `apps/nanocore/src/runtime/`
- `apps/nanocore/src/internal-agents/`
- `apps/nanocore/src/llm/`
- `apps/nanocore/src/storage/`
- `packages/protocol/src/`
- `packages/worker-protocol/src/`
- `packages/worker-shim/src/`
- `packages/app-api-schemas/src/`

## Implementation Gaps

- Restart recovery of accepted input - Exact per-input processing, lost ACK/inbox survival, and unresolved held inputs await qualification - #947

- Original context-package recovery - Recovery does not restore the original package - #132
- Interrupted-worker guidance and disabled-resume projection - Those recovery actions are not projected - #733
- Worker package policy summaries and Knowledge descriptors - Those package contents are absent - #565
- Checkpoint stages are exactly the five accepted stages - The stored schema still admits unproduced `waiting_for_user` - #726

## Decisions

- [Control Kernel And Service Storage](../decisions/20261120-control_kernel_and_service_storage.md)

- [Pre-Stable Data Continuity](../decisions/20261014-pre_stable_data_continuity.md)
- [Truthful Native Stop Classification](../decisions/20261009-truthful_native_stop_classification.md)
- [Large Files And Model Context](../decisions/20261015-large_files_and_model_context.md)
- [Checkpoint-Owned Failed Start](../decisions/20261009-checkpoint_owned_failed_start_closeout_and_release_hold.md)
- [Identifier Derivation And Import Allocations](../decisions/20261016-identifier_derivation_and_import_allocations.md)
- [Terminal Failed-Start Turn Recovery](../decisions/20261003-terminal_failed_start_turn_recovery.md)
- [Execution Backend Port](../decisions/20261006-execution_backend_port_in_nanocore.md)
- [Retire Stateless Quick Chat](../decisions/20261016-retire_stateless_quick_chat.md)
- [Earlier Version Data Not Carried](../decisions/20260930-earlier_version_data_not_carried.md)
