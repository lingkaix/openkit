---
status: Accepted
kind: boundary
implementation: Partial
aspect: communication
---
# Worker Control Protocol

This specification owns `openkit-worker-control-v2`, the end-to-end worker-control wire protocol between governed worker containers and NanoCore, including upward worker-to-NanoCore control routes, the private Worker Shim poll, directional reader and emitter validation, and incremental native work observation envelopes.

## Scope

Owns:

- The worker-visible `/worker-control/*` protocol between Sandbox Integration and NanoCore, including authentication, lineage, monotonic sequencing, idempotency, bounded outage retry, and canonical verification.
- Upward worker-to-NanoCore `heartbeat`, `artifact_notice`, `event_append`, `final_status`, `supply_refresh_ack`, and `capability_summary` routes, plus the cancellation-only first-final exception and transcript Item exact-value replacement.
- The authenticated Worker Shim poll, full inventory and desired set, original Turn input and steer evidence, and interrupt settlement.
- Directional descriptive-reader and exact-emitter validation rules and `native-content-v1` incremental work observation chunk admission.

Does not own:

- The [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md) owns the shim and resident adapter contract and NanoHost adapter liveness. [Compute Neutrality Target](20261020-compute_neutrality_target.md#execution-backend-port) owns the execution backend port.
- Agent Capability routes, session loopback credential minting, attribution, drain, and destruction, and built-in MCP tool supply: [Worker Agent Capability](20260703-worker_agent_capability.md) and [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md) own them.
- NanoHost transport, Runtime Epoch lifecycle, stock OpenShell supervision, RelayStream and HTTP/2 carriage, and predecessor connection fencing: [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md) owns them.
- Durable scheduling, AgentSession continuity records, Task live-steer public lifecycle, and Turn stop-reason canonicalization: [Durable Scheduler Design](20260703-durable_scheduler_design.md), [AgentSession Continuity](20260704-agent_session_continuity.md), [Task Mode Worker Delegation](20260704-task_mode_worker_delegation.md), and [Worker Turn Reliability Envelope](20260531-worker_turn_reliability_envelope.md) own them.
- Workspace snapshot chains and staging, AEP and manifest resolution, and retained work data storage layout: [Workspace Synchronization](20260703-workspace_synchronization.md), [Agent Environment Package](20260616-agent_environment_package.md), [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md), and [Work Data Retention Format](20260921-work_data_retention_format.md) own them.

Core: [Communication](../core/communication.md), [Runtime Model](../core/runtime-model.md), [AgentSession](../core/agent-session.md), [Work Model](../core/work-model.md), [Mediation](../core/mediation.md), [Evidence](../core/evidence.md), [Contract Evolution](../core/contract-evolution.md).

## Endpoint

The worker-visible target endpoint is one sandbox-local Integration binding whose route namespace is `/worker-control/*`. The AEP supplies only the non-secret local binding and worker-control token reference, and Sandbox Integration binds it to the standard HTTP/2 session carried by the sandbox's one stock RelayStream under [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md). The worker never receives a NanoCore address, NanoHost credential, remote Gateway address, SSH target, transport credential, or alternate control endpoint.

Sandbox Integration maps each worker-visible operation-specific request into `/worker-control/*` without changing its envelope. On NanoCore, the accepted upward routes are `/api/worker-control/heartbeat`, `/api/worker-control/artifacts`, `/api/worker-control/events/append`, `/api/worker-control/final-status`, `/api/worker-control/supply-refresh-ack`, and `/api/worker-control/capability-summary`. For per-Turn requests, NanoHost, RelayStream, Gateway, the HTTP/2 session, and the Integration outer adapter are byte-transparent transport intermediaries that MUST NOT inspect, authorize, synthesize, reorder, retry, reinterpret, or terminalize a message. `/inference/*`, `/capabilities/*`, Gateway forwards, direct NanoCore reachability, and transcript sinks are never control paths.

One private poll is available to the current incarnation-bound Worker Shim through the authenticated carrier. The native Agent, App API and Worker-visible routes cannot issue it. On NanoHost the Host relay binds the poll to the exact Sandbox incarnation and current outer connection.

## Authentication

Every worker-visible `/worker-control/*` request MUST authenticate with a worker-control token minted for one AEP snapshot and exact current attempt lineage. Each route token is a 43-character unpadded base64url encoding of an independently generated 32-byte CSPRNG value.

The shim poll authenticates the current incarnation through its carrier admission. Worker, inference, capability, provider, User and administrator credentials do not authorize the poll. The first poll checks current lineage and release before effects. A superseded session or release refusal grants no authority.

The worker-control token is accepted only by `/worker-control/*`. Two distinct independently generated 43-character tokens authenticate `/inference/*` and the AEP-enabled `/capabilities/*` routes respectively; none is derived from or equal to the shim carrier binding or another route token, and each route family MUST reject the other two token families. Shared RelayStream, HTTP/2, NanoHost transport, process, host placement, or restart MUST NOT create token reuse or shared authority.

The worker-control token is scoped to Workspace ID, Thread ID when applicable, Turn ID, AgentSession ID, package snapshot ID, backend session ID or redacted backend session binding, and expiration time. NanoCore MUST reject token reuse across lineage.

Each active Turn's three distinct upstream route credentials are held in live memory only at their issuing and carrying owners and the exact local Turn binding. The shim receives them only for admitted keyed Turn input after the corresponding verifiers and lineage are durable. Bootstrap and inventory carry no raw Turn credentials. The two session loopback credentials remain separate, with only their verifiers durable. [Worker Agent Capability](20260703-worker_agent_capability.md) owns their local route and drain rules.

Before the readiness exchange, the shim generates one random 32-byte process key in memory and encodes it as 43 unpadded base64url characters. The sequence-`0` `starting` heartbeat carries the unpadded base64url SHA-256 digest of those key bytes, which NanoCore immutably binds to the attempt before the native worker child starts. Sequence `1` is the first durable proof that post-launch recovery is enabled and child execution has begun; restart recovery never arms a sequence-`0`-only supervisor. The raw process key stays in shim supervisor memory only and may appear on the wire only as the request-only `reconnectKey` on an exact-next recovery heartbeat alongside the existing bearer token and exact lineage.

The accepted `schemaVersion` literal for worker-control requests, responses is `2` (`openkit-worker-control-v2`), while canonical transcript, event, Artifact, provenance, workspace-change, and inner capability-summary records retain schema version `1` (`packages/worker-protocol/src/index.ts`). No protocol-version negotiation, accepted-version set, build compatibility registry, legacy adapter, or version-1 control-envelope fallback is permitted.

## Envelope

The canonical control request envelope is `WorkerControlRequestEnvelopeSchema` in `packages/worker-protocol/src/index.ts`. `lineage` includes the workspace, thread, turn, AgentSession, package snapshot, backend session binding when applicable, and token scope needed to bind the request to one governed worker execution.

Every admitted keyed Turn input binds a fresh immutable per-Turn Agent Environment Package snapshot and Context Package to the exact Workspace, Thread, Turn, AgentSession, actor, request, Agent, profile, runtime, provider, policy, route credentials, Vault grants, resource limits, observability, and package digest admitted by their owners. A shared Sandbox or Harness MUST NOT receive one Sandbox-wide authorization package or credential that authorizes resident AgentSessions collectively. Static compatibility descriptors are placement evidence only and MUST NOT authorize a Turn, effect, retry, or publication.

An idle or resumed native conversation contributes continuity only. Idle supplies no authority. Refusal of a loopback request with no Turn bound belongs to [Worker Agent Capability](20260703-worker_agent_capability.md). A resumed conversation supplies native continuity only. The newly bound Turn's authority is what a request receives. It MUST NOT supply stale authority or replace current Core context, and old immutable package snapshots remain evidence rather than authority for later Turns.

The envelope does not duplicate an actor. NanoCore resolves the immutable runtime actor only from the exact Turn and AEP snapshot named by that lineage; `AEP.scope.triggerActor` remains the sole runtime actor authority, and a worker-supplied actor or responsible-user field is invalid rather than an override.

Worker-control liveness and terminal records may remain non-authorizing transport evidence after responsible-user authority is lost, but no candidate event, artifact notice, knowledge proposal, capability summary, or collected output may be promoted into canonical Workspace content without the current-authority predicate required by the owning effect. The first worker-control or NanoCore boundary that observes lost authority interrupts the worker, revokes its route authority, terminates the affected sandbox, invalidates the complete Runtime Epoch if the NanoHost cannot prove sandbox deletion completed, and rejects later publication; it adds no control operation, command kind, durable state, quarantine, settlement, or recovery workflow. An already-submitted worker-native external request remains subject to the bounded compromise in the multi-user specification.

`sequence` is monotonic per AgentSession and package snapshot for the relevant control stream. Live append may skip sequence numbers. Exact retries with the same sequence and identical canonical payload are idempotent. The same sequence with different content must fail closed. A lower sequence after a higher accepted sequence fails closed. Ordinary post-launch heartbeats may skip sequence numbers. Each newly accepted higher heartbeat sequence renews liveness, and an exact replay does not renew it.

A control envelope is at most 64 KiB (current default). One live event payload is at most 256 KiB (current default). Larger material moves through the data plane as an artifact, evidence bundle, manifest, or collected file reference, with a typed oversized-payload refusal.

The canonical control response envelope is `WorkerControlResponseEnvelopeSchema` in `packages/worker-protocol/src/index.ts`.

HTTP route-specific projections may put lineage and payload fields directly in route bodies, but they must preserve the same semantics: bounded payload, bearer token, lineage binding, monotonic sequence where the operation is sequenced, and NanoCore-owned verification.

Restart adoption uses the ordinary heartbeat envelope plus request-only `reconnectKey`. NanoCore decodes and hashes the key. NanoHost matches the original process-key verifier and the kernel confirms the live attempt and generation. Adoption also requires exact durable lineage, an open attempt and a NanoHost adapter that holds its `awaiting-reconnect` observation before the preserved deadline. The heartbeat sequence must be exactly the next sequence after the last accepted heartbeat. The adoption compare-and-set advances the sequence and restores the same open attempt to ordinary control; rollback, gaps, conflicting replay, a wrong key, or an expired window fail closed. The raw key is excluded from the canonical heartbeat fingerprint, access logs, diagnostics, and durable records.

If the current heartbeat committed and its acknowledgment was lost, the original process can present that exact heartbeat with its reconnect key. NanoCore applies the same token, lineage, process, current physical authority, and deadline checks as for adoption. When the request matches the durable high-water mark and its complete stored fingerprint, NanoCore returns HTTP 409 with `worker_control_heartbeat_already_accepted`. This readback changes neither the attempt nor its liveness, sequence or recovery window. The Worker may then send exactly one fresh proof at the next sequence. A second refusal stops recovery, including when the fresh proof's outcome is unknown. A stale, gapped, or different heartbeat receives the ordinary refusal. A replay of an authorized old heartbeat across another restart can at most receive the same readback.

There is no application-layer challenge, asymmetric signature, recovery listener, or recovery session state machine. The reconnect request relies on the authenticated confidential NanoHost transport and route-separated Integration carriage that protects the Sandbox bearer token. That separation supports conversation-context isolation and does not provide security and adjudication isolation from a compromised shared Harness. A party that can observe both the bearer token and process key on that path could race the original worker; transport confidentiality and predecessor fencing are therefore explicit boundaries of this V2 compromise rather than a second worker-control cryptographic protocol.

If exact adoption does not complete inside the bounded window, worker control authorizes no compatible replacement and makes no completion claim. The scheduler terminates the old attempt authority, while the NanoHost owns definite sandbox deletion or whole-epoch invalidation when cleanup is uncertain. The owning Turn retains the truthful result its lifecycle owner determined until a new request is authorized. Effect uncertainty and any recovery requirement are expressed by the effect owner and the recovery owner respectively, and interruption MUST NOT infer that an effect did not happen.

## Descriptive Readers And Exact Emitters

Worker-to-NanoCore reports, canonical transcript candidates, observation metadata and chunks, runtime provenance manifests and indexes, capability summaries, acknowledgements, diagnostics and error envelopes are descriptive. Readers MUST strip unknown descriptive keys before fingerprinting, canonical persistence, forwarding or display. Generic control-envelope admission MUST be followed by the operation-specific body reader before any use of that body. Unsupported declared requirements, unknown versions, operations, event kinds, statuses and missing required fields remain failures; sequence, attribution, lineage, process-key proofs, content admission, digest checks and secret exclusions remain binding.

Lineage bindings and Turn capture-coverage admission carry authority and remain exact. Worker-supplied actor or responsible-user fields remain invalid rather than supplying authority. Effect instructions, including the authority-bearing desired set and keyed input, remain exact under [Contract Evolution](../core/contract-evolution.md#closed-core-open-extension). Emitters and known-core fixtures MUST retain exact assertions that catch an unknown emitted key, including when all required fields are present.

Runtime provenance readers MUST verify digests over the original stored bytes before parsing a stripped view. Retained raw streams and index files keep their original bytes. Ordinary portable Workspace import is absent and does not remint a normalized index. Export retains the normalized index and does not recompute an import digest. This creates no compatibility reader, migration, dual write or new lifecycle.

## Worker-To-NanoCore Messages

Control operation names are `WorkerControlOperationSchema` in `packages/worker-protocol/src/index.ts`, listed once under [Canonical Enums](20261021-protocol_identifiers_and_enums.md#canonical-enums).

`heartbeat` reports worker liveness and coarse lifecycle state. It must not carry transcript content.

`event_append` carries small schema-conformant candidate event records only. Large transcript files remain in the exact admitted `/openkit/threads/<threadId>/<harness>/capture/<turnId>/` capture and are collected through the data plane. NanoCore validation and commit, not append acceptance alone, makes product state canonical.

`artifact_notice` announces an artifact path, title, media type, digest when available, and collection hint. It does not upload artifact bytes.

`final_status` records one Turn's final status and evidence manifest digests. Its `status` and product-safe `stopReason` string are worker-control transport facts rather than Core `StopReason` authority. The sole durable owner is the existing immutable server-scope `worker_control_records` row with `operation=final_status`, keyed by AgentSession, package snapshot, operation, and decimal sequence record key and validated against the row's exact Workspace, Thread, Turn, nullable request, attempt, AgentSession, package snapshot, sequence, and canonical terminal-event lineage. The row stores the complete accepted wire payload plus `acceptedAt`; exact fingerprint replay reuses it and changed same-sequence input conflicts. It survives restart, is not Workspace-portable product history, and MUST NOT be copied into a checkpoint, evidence row, or recovery lifecycle. NanoCore then applies the one closed canonicalization table owned by the Worker Turn Reliability Envelope before mode closeout. An unknown or incompatible pair remains durable and yields `recovery_required`; NanoCore does not infer a Core reason from the product Turn projection or adapter-private vocabulary.

`supply_refresh_ack` acknowledges one explicit NanoCore-issued source-to-target supply refresh request only when the resolved AEP declares support proved by the selected image and shared shim. It does not grant execution authority or extend the absolute attempt deadline.

`capability_summary` reports control-plane liveness and summary ids for capability activity. Authoritative capability call records belong to Agent Capability.

## NanoCore-To-Worker Commands

Core delivers interrupt as desired state of the exact Turn and attempt through the same poll. The existing terminal compare-and-set decides whether interrupt is admitted. If terminal wins first, that decision proves no interrupt was admitted. If interrupt admission wins, a later terminal report leaves delivery to be settled by the original interrupt evidence. Preserve the original request and attempt, terminal-versus-interrupt decision, conflicting-request refusal and observed settlement or unknown. An inactive Turn alone proves neither delivery nor non-delivery. Cleanup waits for settlement, including an unknown disposition, before proceeding under the owning fence rules. Reapplying the same desired state issues no second signal. A conflicting request refuses without issuing one.

Interrupt applies only to the addressed Turn. It creates no steer delivery and cannot pause approval or user input. Use [Pending Requests](20260930-pending_requests.md) for those cases. Continuation after interruption uses a newly admitted Turn. Interrupt settlement does not prove Worker absence or close the AgentSession. The original result reports cancellation, refusal or unknown. See [Truthful Native Stop Classification](../decisions/20261009-truthful_native_stop_classification.md) and [Turn Interrupt Is Abandon](../decisions/20260921-turn_interrupt_is_abandon.md).

## Worker Shim Poll

<a id="harness-control-operations"></a>
<a id="harness-pull-and-result-envelopes"></a>

The current shim session pulls. Each poll carries the full scoped Worker inventory, observed Worker state, exit evidence and the outstanding original-operation receipts. The reply carries Core's full desired set for that Sandbox incarnation, desired Turn state for interrupt, and pending keyed Turn input and steer. Replacing a carrier starts a full exchange. Core's connection generation fences old sessions. A session-local revision orders desired sets within the current session. Reject an old session or superseded revision before applying effects. The same desired Worker state cannot realize the same start twice.

Core derives each one-shot operation's key from the existing Core operation ID, target Worker ID and payload digest. Only the existing qualified input and steer boundaries supply effect evidence. The inventory carries original keyed outcomes and interrupt settlement. Keep a produced receipt until Core acknowledges the original key. Preserve the original operation on a lost reply. A negative read-back requires a quiescent receiver and either the original key absent from complete authoritative history or the original sequence unchanged. Missing, overwritten or uncorrelated evidence leaves the effect unknown. A generic key lookup is outside this interface.

Core admits start with the exact Worker incarnation, adapter, work slot, admitted AgentSession and permitted resume reference. Initialize a new work slot before its native runtime starts under [Session Static Workspace Materialization](20260704-session_static_workspace_materialization.md). Keep the exact input, context, attempt and per-Turn credential binding under [Envelope](#envelope). Existing static public environment and Vault declarations must match the current admitted package. An absent environment map carries only the meaning the admitted package permits. Conflicting environment does not patch an active child. Typed desired inputs and reports follow [Descriptive Readers And Exact Emitters](#descriptive-readers-and-exact-emitters). Caller-supplied executables, arbitrary shell or environment, host paths, provider endpoints and unadmitted operations fail before native contact.

A keyed Turn input receipt proves correlated native admission within the addressed Turn. The owner retains exact pending or ready handle evidence when the adapter qualifies deferred native creation. Read-only confirmation and work-slot startup retain the existing typed diagnostic, native-handle and exact evidence requirements. Unknown input whose acceptance cannot be resolved ends the Worker. Keep the original exclusion until its owners settle it. Local stop revokes native continuation authority, preserves retained data and retires only the disposable control slots once the owning collection and cleanup barriers hold.

### Live-Steer Operation Boundary

Keyed steer is the private delivery projection of [Task live steer](20260704-task_mode_worker_delegation.md#live-steer), whose owner holds the public actors, Item, completed receipt, full lifecycle, failures, and acceptance predicates. Live steer is qualified for Codex 0.169.0 and Pi 1.5.2 against the Runtime qualification row in [Task live steer](20260704-task_mode_worker_delegation.md#observable-acceptance). The shipped OpenCode pin 2.3.0 has no qualified steer hook before native contact. OpenCode 2.2.5 remains labelled unsupported. DeepSeek 0.2.1-rc.5 remains unsupported. The Task owner retains the public receipt and applies the original attempt fence while the selected input is unresolved. The [Task Live-Steer Rulings](../decisions/20261008-task_live_steer_rulings.md) record why this operation is separate from interruption. It grants no authority, starts no Turn, changes no setup, and answers no Pending Request. Bounded `input` is typed user content and is never interpreted by the control boundary as an executable instruction or shell command.

Preconditions are the exact current Worker incarnation and AgentSession binding, Workspace, Thread, running Turn, package snapshot, execution attempt, and Turn sequence. `inputItemId` names the already durable ordinary user-message Item; `inputDigest` is SHA-256 of its exact UTF-8 text. NanoCore stores its reference in the queued operation and materializes that bounded text only at authenticated dispatch. The Worker Shim checks the digest and exact active native-work correlation before invoking one qualified adapter mapping. Unknown fields, missing or stale lineage, unsupported required semantics, mismatched text identity, or unqualified support cause a typed refusal before native effect.

`state="accepted"` proves native admission for processing during the addressed active Turn, not model consumption, obedience, completion, or terminal proof. A write to the native pipe or Core receipt of text is insufficient. The adapter must supply exact native acceptance evidence under its own owner; an inability to prove the same-Turn boundary uses disposition `refused` with `reasonCode="unsupported"`, definite non-delivery is `refused`, and possible dispatch without proof is `unknown`. Native identifiers and bodies remain private. The shared result retains exact public Turn, input Item and digest correlation.

When steer delivery is unknown, return that disposition to the waiter and retain the original Workspace delivery and kernel input obligation until exact consumption or governed resolution. NanoCore persists the public disposition through the Task owner. A late receipt settles the original evidence only. It grants no retry, replacement input or reuse of the key.

### Retained Delivery Proof

Current native evidence retains its original owner and correlation. A transport response or native intake ACK proves at most acceptance. Only exact processing read-back establishes consumption. Keep the obligation open until consumption or governed resolution, and record which occurred. Bind the observed input identifier, order and digest, Turn, attempt and generation, original operation, boundary and native proof reference/digest. The adapter retains native details. The kernel checks and commits the bounded proof with its deciding transition before acknowledgement. A repeated message body, current slot or final reply alone cannot prove that input was consumed. Replaying a settled transport receipt cannot dispatch again. When a required boundary cannot be proved, persist unknown or refuse unsupported input before contact.

### Interrupt Delivery Poll Cadence

During an active Turn, use the existing maximum of 1,000 ms between eligible poll starts. An outage pauses the measurement and consumes the existing bounded outage budget. Keep the existing end-to-end interrupt observation bound where that cadence applies. Transport loss alone supplies no redelivery proof. Resume the full poll with the same live shim and original receipts. The NanoHost adapter heartbeat remains independent.

V0.2.0 uses fresh Turn supply at admission. Live supply refresh requires its existing proved AEP and runtime support. Changes that need a new native process use ordinary authorized replacement.

## Final Status

The shim must send one `final_status` for each Turn. That record is not coextensive with a process lifetime.

`final_status` uses `WorkerControlRequestEnvelopeSchema` in `packages/worker-protocol/src/index.ts`. Its producer body is `WorkerCanonicalTerminalEventDataEmissionSchema`. Its receiver body is `WorkerCanonicalTerminalEventDataReaderSchema`. `status` is `WorkerCanonicalTerminalStatusSchema`, listed once under [Canonical Enums](20261021-protocol_identifiers_and_enums.md#canonical-enums). `stopReason` stays a product-safe transport value. The final worker sequence is the control sequence. `evidenceManifestDigests` is an optional descriptive map, open for extension; empty means not reported. The admitted diagnostics contract is the optional `diagnostics` member of the emission artifact. Capability summary ids, audit summary ids, and an error summary are not members of that body. `capability_summary` owns capability summary ids. Audit summaries and error summaries stay with their own owners.

Manifest digests are Worker-reported description, never coverage, proof or acceptance. The two mandatory transcript/artifact digest requirements are retired by the [reserved audit ruling](../decisions/20261031-reserved_audit_question_rulings.md#decision). An omitted evidence-manifest digest map defaults to an empty map. No additional manifest producer is required.

NanoCore derives the canonical Core `StopReason` and Turn status through the Worker Turn Reliability Envelope after evidence collection; it does not rename the wire field or treat the transport value as product-state authority.

`final_status` is the worker's last durable-output barrier for that Turn. Before sending it, the shim MUST seal the terminal transcript and the runtime-provenance records it owns. It does not publish the workspace change set by an in-Sandbox capture. Workspace head, base, digest, and acceptance evidence are the separate `workspace.collect` result owned by [Workspace Synchronization](20260703-workspace_synchronization.md#snapshot-chain). After NanoCore accepts `final_status`, that shim MUST NOT publish more transcript, provenance, or artifact output for the Turn. The next Turn waits until the outside collection owned by [Workspace Synchronization](20260703-workspace_synchronization.md) completes.

Accepted `final_status` is required for the Turn barrier. The separate bootstrap monitor covers the shim lifetime, remains live across Turns, and can prove only its correlated exit. Turn export must not wait for or consume that monitor. Ambiguous cleanup follows the provider's Sandbox-lifecycle proof and escalation. Closing either interactive direction or HTTP/2 session leaves physical termination unproved.

NanoCore may accept `final_status` before it has collected all data-plane evidence. Acceptance means the worker has finished publishing its durable output, not that NanoCore has imported or approved it. The canonical turn cannot close until NanoCore has collected or intentionally marked missing required evidence.

After readiness and admission of the resident host, a lost `final_status` response is retried only with the same logical operation identity, sequence, canonical payload, and remaining shared outage budget. Budget expiry does not start a best-effort final-status grace period; the shim writes its local terminal record and lets durable recovery project the interrupted outcome. Budget expiry fails the affected Turn. It does not kill a shared host or its sibling bindings. Dedicated-host death ends that binding.

### Cancellation-Only First Final On Closing Lineage

A closing lineage may accept one first `final_status` only when Core's existing attempt owner records cancellation for that exact Turn and execution binding. The request must present the exact worker-control token and admitted Workspace, Thread, Turn, AgentSession, package, and attempt lineage. Its cancellation/interruption disposition, logical operation identity, final sequence, schema, and digests must satisfy the existing final-status and sequence checks. A completed or unrelated failure final is not admitted by this exception ([#179 ruling](../decisions/20261015-worker_failure_final_and_chat_call_rulings.md)).

An ordinary event-append refusal on that cancellation-closing lineage does not consume the final operation or revoke its exact worker-control binding solely because the lineage is closing. It grants no inference, capability, event, Artifact, or other output admission. Explicit revocation, fencing, wrong binding/token, deadline expiry, and contradictory cancellation evidence still fail closed.

Before this first final, the shim seals its local terminal transcript and owned provenance under the ordinary final barrier. Acceptance atomically records the existing final identity and fingerprint, seals remote output admission, and permits only exact replay thereafter. A changed sequence, payload, token, operation, or lineage cannot become a second final. Reconnect and restart recover that disposition through existing attempt/control records; they do not reset the one-time exception. This adds no terminal state, credential family, record, or recovery loop.

Acceptance covers cancellation with a refused ordinary append followed by the one valid first final, exact duplicate replay, restart after acceptance, and changed-payload/sequence conflict. It rejects non-cancellation closing, completed finals, stale or wrong tokens/bindings, fenced or revoked attempts, and any new output after sealing. Final acceptance still proves neither cleanup nor canonical Turn completion.

## End-To-End Control And Evidence Collection

The protocol supports end-to-end live append plus turn-end collection from the exact admitted `/openkit/threads/<threadId>/<harness>/capture/<turnId>/*.jsonl` capture. Transcript collection is evidence and deduplication input, not a fallback control mode. Control is fail-fast until the complete readiness exchange succeeds and the resident host is admitted. After that admission, a retryable route outage enters one shared five-minute monotonic outage budget. The worker-control client inside Sandbox Integration keeps the resident host alive, pauses new private Harness polling, and retries only the same immutable logical request every 250 ms within that budget. The Integration outer adapter, NanoHost transport, and other route families do not replay it. Exponential backoff, jitter, and `Retry-After` handling are not part of this contract. The outage budget fails the affected Turn. It does not kill a shared host or its sibling bindings. Dedicated-host death ends that binding.

A NanoCore restart or a short network loss does not cancel a locally accepted OpenShell operation and does not recreate the Sandbox. When the NanoHost transport returns, a successor connection first fences its predecessor, then worker control continues the same AgentSession, attempt, package snapshot, backend session, process key, and exact next sequence. A binding that cannot be proved exactly is closed or fenced, and a successor resumes natively. A late predecessor message is rejected and cannot advance control state.

HTTP 408, 425, 429, 500-599, request timeout, connection refusal/reset, broken pipe, temporary DNS, and temporary TLS/socket failures are retryable after readiness. Schema failure, 401, 403, 404, 409, 413, 422, any other non-retryable 4xx, invalid 2xx JSON, and an invalid success envelope are terminal authority or contract failures and stop the children immediately. String matching is not a normal classifier.

Local transcript append and remote live delivery are separate queues. A remote outage MUST NOT poison local append or prevent one terminal record from being sealed. Exact raw terminal output needed for a same-process retry may remain bounded in shim memory; the durable transcript stores only operation identity, canonical digest, and product-safe summary. Shim restart remains non-recoverable.

## Outage Tolerance Is Two Separate Guarantees

The bounded outage budget above is a worker-control guarantee and nothing more. It is routinely read as "a NanoCore outage does not disturb a running worker", which is false, and the two guarantees that actually exist have different values and must be stated separately.

**Control-plane tolerance** is the single bounded outage budget: a worker survives a NanoCore outage shorter than that budget without losing its attempt, its sequence, or its process, and the execution runtime keeps its local state and its worker process alive for the duration.

**Inference availability during a NanoCore outage is zero.** Inference is routed through NanoCore to the provider, so a NanoCore outage of any duration makes `/inference/*` unavailable for exactly that duration. A worker that needs a model call during the outage stalls; it does not continue. "Local execution survives" therefore means the process, attempt, and sequence survive, not that the agent makes progress.

Neither guarantee may be widened by moving authority downward. The execution runtime MUST NOT open a direct provider path, substitute a provider, serve a cached inference response, or otherwise make an inference effect happen while NanoCore is unreachable, because provider selection, policy, usage attribution, and audit are NanoCore-owned and an unattributed effect is worse than a stalled one.

A worker that exhausts its budget fails through the existing owners. The runtime MUST NOT extend the budget or the attempt deadline to conceal an outage; the attempt's submit-time absolute deadline is immutable, and the NanoHost adapter's existing outage and liveness rules remain additional bounds.

## Canonical Verification

NanoCore verifies:

- token
- lineage
- package snapshot id
- message schema
- worker sequence
- idempotency key or sequence fingerprint
- payload digest when provided
- artifact and workspace path boundaries
- policy decision references
- maximum payload size

After authenticated, lineage-bearing admission, NanoCore stores failed verification as quarantined evidence. Unauthenticated requests and requests without verified lineage MUST NOT create quarantine records. Failed verification never promotes records into product history.

Sequence gaps do not block live event append by default. NanoCore accepts higher valid event sequences, rejects stale lower sequences, and rejects same-sequence conflicting payloads. Missing sequence evidence may produce degraded import or recovery state when transcript collection proves required records are absent.

## Durable Worker-Control State

Every Core-mediated worker-control, inference, and capability route validates its exact attempt, credential family, current policy, explicit revocation, and absolute submit-time deadline. The [NanoHost adapter liveness rule](20260629-worker_runtime_communication_model.md#nanohost-adapter-liveness) additionally retains startup and heartbeat refusal, stale needs-evidence exclusion, exact duplicate non-renewal, and route refusal until exact process-key adoption. That rule is adapter policy, not generic scheduler liveness authority.

A product-safe active-AgentSession control summary resolves through the exact persisted AEP snapshot and complete current lineage. Absent live state or incomplete lineage yields no summary. The read borrows neither an older package nor an AgentSession-only lookup. The projection is not a new state owner, and a general gateway helper stays available to consumers that can use it.

Worker-control state MUST survive NanoCore restart. Process-local gateway state is a bootstrapping projection only; the durable contract is:

- Token bindings are resolved through the durable execution attempt records owned by `docs/specs/20260703-durable_scheduler_design.md`. The NanoHost extension stores exactly three nullable lowercase SHA-256 verifier projections for this profile, one each for the worker-control, inference, and capability tokens, and never a raw value. A family authenticator hashes the presented token and compares it to the exact current open attempt/lineage binding; adapter-stale or fenced lineage, and closed lineage outside exact accepted `final_status` replay, fails authentication and revokes all three through the existing attempt status owner. A `closing` lineage admits only [the cancellation-only first final](#cancellation-only-first-final-on-closing-lineage) or exact accepted `final_status` replay; refusal of an ordinary append solely for that cancellation-closing state must not revoke the final binding. This discharges restart durability through adapter-local verifier records and the current kernel grant.
- The accepted-event high-watermark (last accepted worker sequence and its fingerprint) is durably recorded per AgentSession and package snapshot, so duplicate replay idempotency, stale-sequence rejection, and same-sequence conflict rejection hold across NanoCore restarts, not only within one process run.
- Accepted artifact notices are durable rows; heartbeat state is not separately persisted because the NanoHost adapter's existing heartbeat observations associated with the exact attempt own liveness truth.
- On restart, the worker-control, inference, and capability gateways rebuild their family-specific serving state from the three NanoHost-owned token hashes checked against the live kernel attempt, current AEP and lineage, and high-watermark rows during the boot phase defined by `docs/specs/20260704-nanocore_bootstrap_readiness.md`. The surviving NanoHost and exact AgentSession-local route boundary retain the same raw values, so successor carriage performs no token reissuance, Harness Start, Sandbox or AgentSession creation, or already-current bridge open. A request whose attempt cannot be found or re-adopted is untracked execution and MUST be refused under the scheduler's exact ownership and cleanup rules.
- An open attempt with adapter-owned `awaiting-reconnect` restores authority only through an exact-next heartbeat carrying its memory-only process key. The exact-current readback can precede that proof. Every other operation remains unauthorized until adoption commits. An adopted session immediately regains ordinary control even when another attempt remains pending.
- After adoption commits, replay of the exact same sequence and fingerprint is ordinary idempotent success; rollback, gap, wrong-key replay, or same-sequence payload conflict is terminal.
- Interrupt settlement follows the original request and attempt through the poll. Exact observations and receipts remain separate from product state and physical release.

Retain backend-native Worker-control records, rejected evidence and sequence fingerprints in the NanoHost extension. Keep Core operation intent, deciding evidence and active exclusions in the kernel. The adapter cannot acquire Core authority from a retained route hash or a replayed native record. See [the owner allocation](20260703-storage_layout_record_ownership.md#server-database-allowlist).

### Adapter Identity Is Part Of Verification

A candidate record is shaped inside the sandbox by the runtime adapter, which is the least-trusted component in the path. NanoCore MUST therefore verify the exact adapter identity named by the resolved package snapshot alongside lineage, sequence, schema, and digest, and MUST reject a candidate whose adapter identity does not match. The candidate's own claim about its adapter is not evidence; the package snapshot is.

The three-job separation this realizes — carriage, normalization, acceptance — is owned by `docs/specs/20260629-worker_runtime_communication_model.md` under the Core substrate doctrine in `docs/core/runtime-model.md`. This specification adds only the verification obligation on the operations it owns.

## Relationship To Items

Worker-emitted records may become items only after NanoCore verification.

The shim can suggest item records, but NanoCore owns:

- item ids
- item sequence in the turn log
- redaction
- causation links
- artifact linkage
- approval linkage
- final turn state

### Exact-Value Protection At Transcript Item Admission

Before creating an Item from worker transcript content, NanoCore MUST apply the shared exact injected-value comparison rule owned by [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md#workspace-and-artifact-plane-projections), including that owner's distinct route-token and loopback hash domains and permitted restart reconstruction. Each matched byte range MUST be replaced with the fixed marker `[redacted]` before canonical creation. A match still creates the Item and does not reject the reply. Overlapping matches MUST leave none of the matched bytes in the admitted text.

The covered Item fields are the `assistant-message` body, supplied as `text` or assembled by concatenating its text `parts`, and the `artifact-reference` title derived from a worker Artifact declaration. When `text` is present it is the admitted body; otherwise all text parts are concatenated before checking, so a value split across parts is caught. The Artifact reference MUST mirror the guarded canonical Artifact title rather than retaining a second unguarded copy. Tool-call arguments and results are not accepted transcript Item kinds and gain no new admission path through this rule. NanoCore owns the resulting canonical Items; worker files remain candidates. Matched original bytes and comparison values MUST NOT be persisted or logged by canonical admission. This is exact-value protection, not generic DLP: credential-looking strings outside the injected set remain unchanged, and encoded, transformed, derived, or non-literal material is outside this check. The decision and reason are recorded in [Transcript Item Exact-Value Guard](../decisions/20261005-transcript_item_exact_value_guard.md).

The check runs before any transcript Item write, including restart closeout and exact replay, using complete evidence for the original materialization under the communication model's reconstruction and association rule; current-value substitution and skipped checks are forbidden. Only genuinely unavailable or contradictory required evidence after that permitted reconstruction makes transcript import return `recovery_required` with product-safe diagnostics and zero transcript Item, Artifact, or Review writes, after the existing backend cleanup lifecycle. It MUST NOT silently publish unchecked text. Recovery follows the existing closeout and replay owners once the exact comparison evidence is available; this rule adds no durable record, automatic retry, update lifecycle, or termination lifecycle. Acceptance is an Item containing the fixed marker and no matched value, an unchanged body when no exact match exists, or the zero-write recovery result when evidence is unavailable.

## Relationship To Agent Capability

Capability calls do not flow through the control plane.

The control plane may carry `capability_summary` notifications so NanoCore can update liveness or progress displays, but the authoritative capability call record belongs to Agent Capability.

Only `event_append` may create item-visible progress by default, and only after NanoCore validates and commits the candidate event record. Heartbeats, artifact notices, final status, and capability summaries are control records until NanoCore explicitly imports or projects them into product state.

## Relationship To Data Plane

The data plane moves:

- artifacts
- workspace snapshots
- patches
- changed-file manifests
- raw transcripts
- raw logs
- backend evidence

The control plane only announces readiness, digests, and collection hints.

## Incremental Work Observations

Native content uses the single `native-content-v1` codec. It fixes RFC 8785 interpretation for canonical JSON content without converting native transcript or log bytes into JSON. `native-transcript` and `runtime-log` are truthful fact kinds, not additional coverage families; actual log source classes are `stderr` and `stdout-log`, never protocol/RPC stdout. Native bodies admit `application/octet-stream` as well as the existing text and JSON media. Source facts retain actual harness and separately authored/measured version identities, admitted image/source, pre-launch watermark, source/Turn association, native ranges, measured observed and retained counts, nullable unknown omissions and observed end/coverage. Existing origin/source/sequence and byte identity members are reused; transport chunk offsets do not become native source offsets. Unknown codec/core values or inconsistent ranges/counts fail closed. Metadata alone never proves native collection or completion.

For native expected content, the existing `content.boundary` member is exactly `native-content-v1`; do not add another codec/version tag. Native facts reuse `coverage` and its existing `reason` domain. Their required `native` object has the following source facts; none supplies execution or Policy authority. Source and origin association remain the existing outer `sourceRef`, `sourceSequence`, `runtimeOriginRef` and authenticated event lineage, not copied owner IDs.

| Native member | Meaning |
| --- | --- |
| `harness` | Actual native harness kind, checked against the named AEP's `agent.runtimeKind`. |
| `authoredVersion` | The exact author label from that AEP's `agent.runtimeVersion`, not measured-version proof. |
| `measuredVersion` | Independently observed native binary version string, or explicit `null` when unknown. |
| `imageDigest` | Worker-reported digest, or explicit `null` when unknown. Core compares a non-null claim with the existing unique NanoHost backend binding for the exact Workspace/Thread/Turn/AgentSession/package: the immutable reference digest or NanoHost build-result digest. With no unique bound digest, the claim remains unverified descriptive data, never authority, and is not refused on that claim alone. A tag or author label cannot become a measured digest. |
| `format` | Actual source's native format name, or `null` when unobserved; not a normalized message schema or another version taxonomy. |
| `preLaunchWatermark` | Measured native source byte position before launch, or `null` when unobserved; it is not a control-plane high-watermark. |
| `range` | `{start,end}` half-open native byte interval for this unit, or `null` with no retained bytes; safe nonnegative integers, end not before start and start not before a known watermark. |
| `observedBytes`, `retainedBytes` | Measured byte counts for this source unit; observed bytes may be `null` when unmeasured. Retained bytes equal the interval length and cannot exceed known observed bytes. Expected content requires known format, watermark, interval and observed count, and body length equals retained bytes. Publication, not these producer counts, proves Core adoption. |
| `omittedBytes` | Measured omitted bytes, or explicit `null` when unmeasured. A known value cannot exceed observed bytes minus retained bytes; do not infer it from an incomplete source. |
| `sourceEnded` | Whether this source's end was actually observed; it does not prove Turn completion, remote stop or complete retention. |
| `logSource` | Required only for `runtime-log`: exactly `stderr` or `stdout-log`. It is absent for `native-transcript`; protocol/RPC stdout is not a log source. |

Core cites the selected bound through its existing AEP association reference (`kind: aep-snapshot`, same authenticated snapshot ID and Workspace). The Worker supplies no new budget reference or grant. An admitted AEP contains the selected numeric `observability.evidence.nativeLogMaxBytes`; source facts cite that immutable record, never duplicate its authority.

`policy.workDataCapture.nativeLogMaxBytes` is a positive safe integer with a combined 16 MiB per-Turn default for native logs. NanoCore selects it once into `observability.evidence.nativeLogMaxBytes` when admitting the AEP. Native log admission reads the exact authenticated named snapshot and existing retained source/publication facts; it does not reread live policy, add a Turn budget or duplicate that value in `captureCoverage`. Missing or invalid historical native authority refuses native content rather than guessing a bound. All sources and packages in the Turn share the same allowance; exact replay cannot recharge it and another package cannot renew it. Transcripts are not charged to the log budget. OFF retains required structure without bytes, and absent source, silence, collector failure and truncation stay distinct. The receiver preserves current byte limits, publication/receipt boundaries and anchored gaps, without a counter table, new writer or cross-domain atomicity. This prerequisite enables no native producer, runtime capability or default; existing ON/OFF bindings and defaults remain unchanged.

The existing canonical event append accepts strict observation.recorded metadata and observation.content.chunk records under its existing outer lineage, revocation, sequence and replay checks. AEP projects the admitted Turn capture binding. Metadata is an observation-family fact, never an Item or child execution command. Chunks are canonical base64 with a maximum 48 KiB decoded length and validated index/offset; complete body length and digest are verified before publication. Metadata declares expected content first; each chunk ACK proves restricted staging, and a separate publication observation follows durable complete-body adoption. An unavailability record for already-declared content carries its exact expected observation identity; Core validates the earlier expected record within the same authenticated package and resolves that identity to the observation parent. A call reference alone is not an anchor because arguments, results and multiple events may share it. Receipt/fingerprint state contains only safe descriptors and digests, never content bytes. The acceptance/replay path must reconcile an interrupted publication before reporting its success. Full body admission, exclusions and failures follow 20260921-work_data_retention_format.md; there is no second transport, execution high-watermark or child-management API.

## Acceptance

During an active Turn, qualify the poll cadence under saturating permitted inference and measure the admitted interrupt through its correlated settlement. On the co-residency enabling release, verify independent sibling outcomes, refusal of an obsolete desired set, and preservation of the original admitted interrupt evidence when terminal status wins the reply race.

## Implementation

- `apps/nanocore/src/runtime/`
- `packages/worker-protocol/`
- `packages/worker-shim/`

## Implementation Gaps

- Incarnation-bound shim poll - Full inventory and desired-set exchange with retained steer and interrupt evidence remain to qualify - #951
- Durable per-input proof - Worker control has not qualified exact receiver read-back against lost ACKs, equal-text input and successor exclusion - #947

## Decisions

- [Control Kernel And Service Storage](../decisions/20261120-control_kernel_and_service_storage.md)

- [Turn interrupt is abandon](../decisions/20260921-turn_interrupt_is_abandon.md)
- [First accepted base by baseline scan](../decisions/20260930-first_accepted_base_by_baseline_scan.md)
- [Native environment managed outside the Sandbox](../decisions/20260930-native_environment_managed_outside_the_sandbox.md)
- [Closed core, open extension](../decisions/20260930-closed_core_open_extension.md)
- [Earlier-version data](../decisions/20260930-earlier_version_data_not_carried.md)
- [Transcript item exact-value guard](../decisions/20261005-transcript_item_exact_value_guard.md)
- [Task live-steer rulings](../decisions/20261008-task_live_steer_rulings.md)
- [Worker failure final and chat call rulings](../decisions/20261015-worker_failure_final_and_chat_call_rulings.md)
- [Reserved audit question rulings](../decisions/20261031-reserved_audit_question_rulings.md)
