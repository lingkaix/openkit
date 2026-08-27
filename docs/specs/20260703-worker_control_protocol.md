---
status: Accepted
implementation: Partial
updated: 2026-08-21
---
# Worker Control Protocol

## Summary

This spec defines `openkit-worker-control-v1`, the minimal end-to-end control protocol between governed worker containers and NanoCore, independent of the transport intermediaries that carry it.

The clean target is narrow: control is for session liveness, candidate event append, final status, the typed interrupt command, and small notifications. It is not an agent capability gateway projection, shell gateway, file-transfer channel, product-state API, or replacement for workspace review.

V1 serves the current one-process, one-configured-NanoHost shared-runtime profile with multiple open AgentSessions for distinct Threads and one active Turn across the first-slice Harness. It preserves exact same-worker continuity across a bounded NanoCore restart or outage through predecessor-fenced NanoHost reconnect; it does not provide concurrent active Turns, AgentSession replacement, transparent failover, or distributed control availability.

## Owns

- The worker-visible end-to-end control-plane protocol between Sandbox Integration and NanoCore.
- Control-plane lineage, sequence, authentication, idempotency, retry, and verification rules.
- Worker-to-NanoCore liveness, candidate event append, final status, artifact notice, and capability summary semantics.
- NanoCore-to-worker delivery semantics for the typed interrupt command.
- The fixed Sandbox Integration-to-Harness AgentSession and Turn control operations, their authority boundary, and the prohibition on arbitrary executable instructions.
- The exact Integration-initiated Harness-control pull and result paths, envelopes, operation identity, sequence, refusal, idempotency, reconnect, and replay semantics.
- The rule that worker-control records become product-visible only after NanoCore verification.
- End-to-end control delivery and local session-file evidence requirements.

## Does Not Own

- Agent Capability calls for LLM, MCP, tools, network, credentials, context, usage, or rate limits.
- Large artifact transfer, patch transfer, raw transcript transfer, or workspace snapshot transfer.
- Product item schemas, turn log storage, audit ledgers, metering ledgers, or workspace review records.
- Runtime-native transcript parsing rules.
- Deployment-specific reachability mechanics beyond the worker-visible protocol contract.
- NanoHost identity, Runtime Epoch lifecycle, RelayStream or HTTP/2 feasibility, route carriage, predecessor connection fencing, and sandbox lifecycle.
- Harness placement, compatibility, capacity grants, native adapter implementation, and product scheduling decisions.

## Core References

- `docs/core/communication.md`
- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-workflow.md`
- `docs/core/agent-capability.md`
- `docs/core/audit.md`
- `docs/core/metering.md`

## Goals

- Define the worker-visible sandbox-local Integration route family.
- Define request lineage, sequence, idempotency, and authentication requirements.
- Define worker-to-NanoCore messages and NanoCore-to-worker commands.
- Support mandatory end-to-end delivery through the accepted Integration projection while retaining transcript evidence on the data plane.
- Keep Sandbox Integration subordinate to NanoCore canonical verification.

## Non-goals

- Do not carry large artifacts, patches, bundles, or raw logs over the control plane.
- Do not expose arbitrary shell execution.
- Do not let Sandbox Integration mutate product state.
- Do not duplicate capability calls; the future `/capabilities/*` route family owns privileged services.
- Do not define runtime-native transcript parsing in this spec.
- Do not add a general offline command queue, replacement-worker protocol, multi-target failover, settlement workflow, or feature-specific recovery harness.

## Background

`docs/specs/20260629-worker_runtime_communication_model.md` requires every real worker container to run Sandbox Integration and expose an AEP-resolved sandbox-local `/worker-control/*` binding. `docs/specs/20260802-nanohost_runtime_and_transport.md` carries that protocol through one standard HTTP/2 session inside one stock OpenShell RelayStream and the one authoritative NanoCore-to-NanoHost session.

The missing design is the concrete protocol boundary and message family.

## Current Implementation Projection

The command poll cadence is accepted and not currently satisfied. The shim sleeps a fixed 1000 ms and then issues a heartbeat followed by a command poll, so the start-to-start interval is 1000 ms plus two round trips. The current shim also couples heartbeat to the poll, which under this cadence would emit heartbeats far more often than the lease heartbeat interval requires. Both are implementation gaps against this section, not accepted behavior.

The current implementation satisfies the closed V1 protocol semantics and the shared-Harness transport projection in local code and tests; refreshed real-host and fault-acceptance evidence remains pending:

- `packages/worker-protocol` owns the shared schema vocabulary for worker lineage, schema-conformant candidate event records, worker-control operation names, and bounded request/response envelopes.
- `packages/worker-shim` is the current Sandbox Integration and owns both the credential-free private Harness pull/result client and the Sandbox-side bearer-authenticated per-Turn control client carried through the same nested HTTP/2 bridge and NanoHost route projection. Its one concrete Codex Harness holds AgentSession bindings for distinct Threads and uses the existing shared process-group supervisor for at most one active Turn.
- `apps/nanocore/src/runtime/worker-control-gateway.ts` owns the process-local gateway state for one registered Agent Environment Package snapshot: sandbox token or scheduler-owned sandbox binding ref, heartbeat, artifact notices, interrupt commands, supply refresh acknowledgements, capability summaries, accepted events, and product-safe snapshots. The default server gateway persists accepted worker-control records into `worker_control_records`, interrupt delivery state into `worker_control_commands`, quarantined verification failures into `worker_control_rejected_evidence`, and restores live lease-backed sessions from durable rows on process startup.
- `apps/nanocore/src/app.ts` projects the accepted gateway routes at `/api/worker-control/heartbeat`, `/api/worker-control/artifacts`, `/api/worker-control/commands/poll`, `/api/worker-control/commands/ack`, `/api/worker-control/events/append`, `/api/worker-control/final-status`, `/api/worker-control/supply-refresh-ack`, and `/api/worker-control/capability-summary`. The retired `/api/worker-control/knowledge-proposal-summary` route remains absent.
- Tests cover token binding, lineage checks, heartbeat recording, artifact notices, interrupt polling and acknowledgement, candidate event append, the 64 KiB typed control-envelope cap, the 256 KiB live event append cap, process-local sequence replay handling for heartbeat, artifact notice, supply-refresh acknowledgement, capability summary, durable sequence-fingerprint replay checks for the default server gateway, durable accepted-record writes for default server heartbeat and event append routes, durable interrupt transitions from queued to delivered to acknowledged, rejected-evidence quarantine for gateway verification failures, and live lease-backed gateway rebuild from durable rows. Restart rebuild restores only unacknowledged `interrupt` rows; acknowledged interrupts and retired command kinds remain inert. Duplicate replay idempotency, stale sequence rejection, and conflicting same-sequence rejection are implemented and tested for the `event_append` channel and the other sequenced control streams, with server-scope durable fingerprint checks preserving same-sequence conflict rejection across default gateway instances.

The former `knowledge_proposal_summary` envelope, route, gateway projection, persisted control record, and direct pending-Proposal import were deleted without an alias. Worker output may support a proposal only through the explicit Skill/CLI composition and complete S61 proposal contract.

The former App API arbitrary-command issuer, caller-selected `argv` and `cwd` shape, terminal-result route, gateway state, and shared-shim executor are deleted end to end. `interrupt` is the only current worker-control command.

The active restart slice adds one shared bounded retry loop in the shim, a memory-only worker process key, and exact-next heartbeat adoption through the ordinary heartbeat route. NanoCore binds only the key hash to the lease, and direct terminal closeout reuses accepted final-status, backend-session, lease, checkpoint, and workspace records. Full data-plane evidence promotion remains outside this spec and is owned by the workspace synchronization, worker runtime communication, audit, evidence, and review specs.

The projection remains Partial because terminal lease transition and takeover do not yet drain outstanding durable command rows to `undeliverable`; current command persistence implements only `queued`, `delivered`, and `acknowledged`. Closing that gap must reuse the existing command row and scheduler transition rather than add another recovery owner or state machine.

The current production route uses NanoHost, one stock RelayStream pair, Sandbox Integration, and nested standard HTTP/2 for per-Turn worker-control and inference plus the two private Harness paths. NanoHost injects the current Harness binding, NanoCore owns one sequenced operation with exact replay and unknown widening, the shared worker supervisor admits multiple Codex AgentSessions with one active Turn, and raw route credentials exist only at `turn.start` dispatch and the live route. The private poll implements the 250–1000 ms cadence and mode-exclusive interruption. Legacy Cell, SSH lifecycle, Gateway-forward, and sandbox-direct source is deleted, and retained A1 evidence passes liveness, restart, recovery, and fault acceptance.

## Endpoint

The worker-visible target endpoint is one sandbox-local Integration binding whose route namespace is:

```text
/worker-control/*
```

The AEP supplies only the non-secret local binding and worker-control token reference. Sandbox Integration binds it to the standard HTTP/2 session carried by the sandbox's one stock RelayStream. The worker never receives a NanoCore address, NanoHost credential, remote Gateway address, SSH target, transport credential, or alternate control endpoint.

Sandbox Integration maps each worker-visible operation-specific request into `/worker-control/*` without changing its envelope. For those per-Turn requests the NanoHost, RelayStream, Gateway, HTTP/2 session, and Integration outer adapter are transport intermediaries: they MUST NOT inspect, authorize, synthesize, reorder, retry, reinterpret, or terminalize the message. The two fixed private Harness paths below have only the connection-binding adaptation explicitly assigned to NanoHost and no semantic delegation. `/inference/*`, `/capabilities/*`, a Gateway forward, direct NanoCore reachability, and a transcript sink are not alternate control paths.

Two exact paths inside that namespace are Integration-private Harness carriage rather than worker-visible routes:

```text
POST /worker-control/harness/poll
POST /worker-control/harness/result
```

Only the long-lived Sandbox Integration supervisor may issue them. A native Agent child, App API caller, worker-control client, sibling route, or arbitrary path cannot issue a Harness operation. The NanoHost transport owner binds those two requests to the exact current nested H2 connection and Harness as specified by `docs/specs/20260802-nanohost_runtime_and_transport.md`; all other `/worker-control/*` requests retain their existing per-Turn token and lineage contract.

## Authentication

Every worker-visible request must authenticate with a worker-control token minted for one AEP snapshot and exact current lease lineage. It is a 43-character unpadded base64url encoding of an independently generated 32-byte CSPRNG value.

The two exact Harness-control paths run before or outside a Turn and therefore MUST NOT accept a worker-control, inference, capability, NanoHost, Gateway, provider, Vault, user, or server-admin bearer credential. Their authentication is the conjunction of the current exclusive Integration-client nested H2 connection, its NanoHost-owned bridge and Harness binding, the current authoritative outer NanoHost connection, and NanoCore verification of the exact current private `harnessBindingRef`. Integration sends no `Authorization` header and cannot supply the binding ref. NanoHost rejects either client-supplied `authorization` or `x-openkit-harness-binding`, then adds exactly one `x-openkit-harness-binding` value from its private bridge context on the outer projected request; NanoCore accepts that header only from the authenticated authoritative NanoHost transport and rejects it on synthetic, public, direct, stale, predecessor, wrong-Harness, or ordinary worker-control requests. The ref is opaque non-secret routing metadata, not a credential, AgentSession identity, independent grant, or fallback token.

The worker-control token is accepted only by `/worker-control/*`. A distinct independently generated token authenticates `/inference/*`; neither token is derived from or equal to the non-secret `sandboxBindingRef`. Worker control MUST reject the inference token, inference MUST reject the worker-control token, and capability remains disabled and accepts neither. Shared RelayStream, HTTP/2, NanoHost transport, process, host placement, or restart MUST NOT create token reuse or shared authority.

The token is scoped to:

- workspace id
- thread id when applicable
- turn id
- AgentSession id
- package snapshot id
- backend session id or redacted backend session binding
- expiration time

NanoCore must reject token reuse across lineage.

Each active Turn's two raw route tokens remain live-memory only in NanoCore, in NanoHost while carrying that exact admitted Turn operation, and at the AgentSession-local `turn.start` route boundary. Harness bootstrap, Harness-global argv and environment, and Sandbox-wide files contain neither. The fixed Turn launcher exposes the worker-control token only through its AgentSession-local descriptor and exposes the inference token only through its separately authorized sanitized native-Agent binding. Raw tokens never enter SQLite, the AEP, Context Package, command/result retention, native configuration, diagnostics, stdout, stderr, transcript, evidence, ordinary logs, or a sibling AgentSession route. This supplies conversation-context isolation and route-authority separation; it does not claim security and adjudication isolation from a compromised shared Harness.

Before the readiness exchange, the shim generates one random 32-byte process key and encodes it as unpadded base64url. The sequence-zero `starting` heartbeat carries the unpadded base64url SHA-256 digest of those exact key bytes; NanoCore immutably binds that digest to the lease before the worker Agent child may start. Sequence one is the first durable proof that post-launch recovery is enabled and child execution has begun, so restart recovery never arms a sequence-zero-only supervisor. The raw key remains only in the shim supervisor's memory and is never written to Core, a file, transcript, child environment, evidence record, or log.

The raw process key may appear only as the request-only `reconnectKey` on an exact-next recovery heartbeat. It is an adjunct to the existing sandbox bearer token and exact lineage, not a reusable control credential or a replacement token.

The one current `schemaVersion` literal is the only accepted worker-control contract. This design adds no protocol-version negotiation, accepted-version set, build compatibility registry, legacy adapter, or rollback behavior. A different schema fails closed.

## Envelope

The canonical control request envelope is:

```text
schemaVersion
lineage
sequence
operation
body
```

`lineage` includes the workspace, thread, turn, AgentSession, package snapshot, backend session binding when applicable, and token scope needed to bind the request to one governed worker execution.

Every `turn.start` binds a fresh immutable per-Turn Agent Environment Package snapshot and Context Package to the exact Workspace, Thread, Turn, AgentSession, actor, request, Agent, profile, runtime, provider, policy, route credentials, Vault grants, resource limits, observability, and package digest admitted by their owners. A shared Sandbox or Harness MUST NOT receive one Sandbox-wide authorization package or credential that authorizes resident AgentSessions collectively. Static compatibility descriptors are placement evidence only and MUST NOT authorize a Turn, effect, retry, or publication.

An idle or resumed native conversation contributes continuity only. It MUST NOT supply stale authority or replace current Core context, and old immutable package snapshots remain evidence rather than authority for later Turns.

The envelope does not duplicate an actor. NanoCore resolves the immutable runtime actor only from the exact Turn and AEP snapshot named by that lineage; `AEP.scope.triggerActor` remains the sole runtime actor authority, and a worker-supplied actor or responsible-user field is invalid rather than an override.

Worker-control liveness and terminal records may remain non-authorizing transport evidence after responsible-user authority is lost, but no candidate event, artifact notice, knowledge proposal, capability summary, or collected output may be promoted into canonical Workspace content without the current-authority predicate required by the owning effect. The first worker-control or NanoCore boundary that observes lost authority interrupts the worker, revokes its route authority, terminates the affected sandbox, invalidates the complete Runtime Epoch if the NanoHost cannot prove sandbox deletion completed, and rejects later publication; it adds no control operation, command kind, durable state, quarantine, settlement, or recovery workflow. An already-submitted worker-native external request remains subject to the bounded compromise in the multi-user specification.

`sequence` is monotonic per AgentSession and package snapshot for the relevant control stream. Exact retries with the same sequence and identical canonical payload are idempotent. The same sequence with different content must fail closed. Lower stale sequences must fail closed after a higher event sequence has been accepted.

The canonical control response envelope is:

```text
schemaVersion
accepted
nextExpectedSequence
diagnostics
```

HTTP route-specific projections may put lineage and payload fields directly in route bodies, but they must preserve the same semantics: bounded payload, bearer token, lineage binding, monotonic sequence where the operation is sequenced, and NanoCore-owned verification.

Restart adoption uses the ordinary heartbeat envelope plus request-only `reconnectKey`. NanoCore decodes and hashes the key, then authorizes adoption only when the hash equals the immutable lease binding, the complete durable lineage is exact, the lease is still `awaiting-reconnect` before its preserved deadline, and the heartbeat sequence is exactly the next sequence after the last accepted heartbeat. The adoption compare-and-set advances the sequence and returns the lease to ordinary control; rollback, gaps, conflicting replay, a wrong key, or an expired window fail closed. The raw key is excluded from the canonical heartbeat fingerprint, access logs, diagnostics, and durable records.

There is no application-layer challenge, asymmetric signature, recovery listener, or recovery session state machine. The reconnect request relies on the authenticated confidential NanoHost transport and route-separated Integration carriage that protects the Sandbox bearer token. That separation supports conversation-context isolation and does not provide security and adjudication isolation from a compromised shared Harness. A party that can observe both the bearer token and process key on that path could race the original worker; transport confidentiality and predecessor fencing are therefore explicit boundaries of this V1 compromise rather than a second worker-control cryptographic protocol.

If exact adoption does not complete inside the bounded window, worker control authorizes no compatible replacement and makes no completion claim. The scheduler terminates the old lease authority, while the NanoHost owns definite sandbox deletion or whole-epoch invalidation when cleanup is uncertain. The owning Turn remains interrupted, unknown, or `recovery_required` until a new request is authorized.

## Worker-To-NanoCore Messages

Control operation names:

- `heartbeat`
- `artifact_notice`
- `command_poll`
- `command_ack`
- `event_append`
- `final_status`
- `supply_refresh_ack`
- `capability_summary`

`heartbeat` reports worker liveness and coarse lifecycle state. It must not carry transcript content.

`event_append` carries small schema-conformant candidate event records only. Large transcript files remain in `/openkit/session` and are collected through the data plane. NanoCore validation and commit, not append acceptance alone, makes product state canonical.

`artifact_notice` announces an artifact path, title, media type, digest when available, and collection hint. It does not upload artifact bytes.

`command_poll` is the worker's pull-based request for pending NanoCore commands.

`command_ack` acknowledges delivery handling for interrupt commands.

`final_status` records the worker's final bounded-step status and evidence manifest digests. Its `status` and product-safe `stopReason` string are worker-control transport facts rather than Core `StopReason` authority. The sole durable owner is the existing immutable server-scope `worker_control_records` row with `operation=final_status`, keyed by AgentSession, package snapshot, operation, and decimal sequence record key and validated against the row's exact Workspace, Thread, Turn, nullable request, lease, AgentSession, package snapshot, sequence, and canonical terminal-event lineage. The row stores the complete accepted wire payload plus `acceptedAt`; exact fingerprint replay reuses it and changed same-sequence input conflicts. It survives restart, is not Workspace-portable product history, and MUST NOT be copied into a checkpoint, evidence row, or recovery lifecycle. NanoCore then applies the one closed canonicalization table owned by the Worker Turn Reliability Envelope before mode closeout. An unknown or incompatible pair remains durable and yields `recovery_required`; NanoCore does not infer a Core reason from the product Turn projection or adapter-private vocabulary.

`supply_refresh_ack` acknowledges one explicit NanoCore-issued source-to-target supply refresh request only when the resolved AEP declares support proved by the selected image and shared shim. It never gates or acknowledges same-snapshot lease renewal.

`capability_summary` reports control-plane liveness and summary ids for capability activity. Authoritative capability call records belong to Agent Capability.

## NanoCore-To-Worker Commands

Current implemented command family:

- `interrupt`

Commands are delivered by worker polling in the first implementation. A backend push channel may be added later only if it preserves the same authorization, lineage, sequence, and delivery semantics.

The durable worker-command row is the sole interrupt-delivery owner for the implemented `bounded-turn` path. It is not used by a `session-continuity` AgentSession admitted to the target shared Harness. For that mode, the exact same product interrupt authorization creates only the private `turn.interrupt` Harness operation below, and NanoCore MUST NOT enqueue, deliver, acknowledge, translate, mirror, retry, or fall back to a worker `interrupt` command for that Turn. Conversely, a `bounded-turn` execution never receives private `turn.interrupt`. The existing shared process-group supervisor remains the one local termination-effect owner in both modes; only its mutually exclusive delivery projection changes.

The existing Turn and lease terminal compare-and-set is the sole race owner. If an accepted terminal transition wins first, no interrupt delivery record or Harness operation is created and the existing already-terminal result is returned. If interrupt authorization wins first, exactly one mode-selected delivery owner is admitted; a later terminal report remains evidence for the Worker Turn Reliability Envelope and cannot create a second interrupt or let an operation result directly terminalize product state. A same-Turn request found in the other mode's owner, a second non-identical interrupt, or a concurrent mode change is a conflict and produces zero additional process signal. Delivery uncertainty follows only the selected owner's existing semantics: the bounded-turn command row follows its acknowledgement contract, while shared-Harness `turn.interrupt` follows dispatched-command non-redelivery and unknown-cleanup widening. Neither path retries through the other.

## Harness Control Operations

Sandbox Integration exposes exactly these fixed typed operations to its declared Harness adapter:

- `session.open` creates one private adapter binding for one already-admitted Core AgentSession and either binds its exact native conversation or records the adapter-authorized pending state until the first Turn;
- `session.inspect` returns bounded product-safe identity, liveness, capability, and cleanup proof for exact verification;
- `turn.start` starts one already-authorized Turn in one exact AgentSession with its per-Turn package, Context Package, lease, route bindings, and sequence;
- `turn.interrupt` requests interruption of one exact active Turn and AgentSession;
- `session.close` revokes and removes one exact native conversation and its AgentSession-local state;
- `harness.drain` refuses new `session.open` and `turn.start` operations while admitted work and cleanup settle.

This specification is the unique protocol owner for those operation meanings and exclusions. The NanoHost runtime specification owns placement and Harness lifecycle, Sandbox Integration owns local routing and supervision, NanoCore owns selection and authorization, and the Harness owns only execution of the selected native-runtime operation. The names are private protocol vocabulary and create no App API, product command, public schema, shell gateway, or generic runtime API.

### Harness Pull And Result Envelopes

Sandbox Integration has at most one Harness-control request open. While the Harness is route-ready and no prior Harness operation is unsettled, it polls start-to-start at least 250 ms and at most 1000 ms apart after NanoCore returns no work; the maximum remains mandatory while a Turn is active so private `turn.interrupt` has the same delivery budget as the mode it replaces. The exact poll body is `{ "schemaVersion": 1, "nextExpectedSequence": <non-negative safe integer> }`. NanoCore returns empty `204` when no operation is queued for that exact sequence or one `200` command with exactly these fields:

```text
schemaVersion = 1
operationId = lowercase 64-hex identity
sequence = nextExpectedSequence
operation = one of the six fixed literals
body = exact operation-specific object
```

`operationId` is the lowercase SHA-256 of the Harness binding, operation sequence, operation literal, and canonical redacted body identity derived by the existing NanoCore runtime owner. For `turn.start`, the redacted identity contains the two durable route-token hashes rather than either raw token. NanoHost and Integration cannot select the id or sequence. NanoCore permits exactly one queued or dispatched operation per Harness, stores that state with the private `HarnessInstanceRecord`, and advances the sequence only after one exact result settles. A queued operation stores only admitted non-secret lineage and body references. At `turn.start` dispatch, one checked transaction mints the two raw route tokens, persists their hashes on the exact lease, derives `operationId`, and marks the command dispatched before returning the one response containing those raw values; a crash after that commit is uncertain delivery and never regenerates or redelivers them. Other operation identities are fixed no later than dispatch by the same record transition. This is not the worker `interrupt` queue, a NanoHost effect, an App command, a general command table, or an offline backlog.

The command body field sets are closed:

| Operation | Exact command-body fields |
| --- | --- |
| `session.open` | `agentSessionId`, `agentSessionRuntimeBindingId`, `workspaceId`, `threadId`, `adapterId`, `agentSessionCompatibilityKey`, `effectiveSetupGeneration` |
| `session.inspect` | `agentSessionId`, `agentSessionRuntimeBindingId` |
| `turn.start` | `agentSessionId`, `agentSessionRuntimeBindingId`, `workspaceId`, `threadId`, `turnId`, `packageSnapshotId`, `aepRef`, `contextPackageId`, `contextRef`, `leaseId`, `deadline`, `turnSequence`, `workerControlToken`, `inferenceToken` |
| `turn.interrupt` | `agentSessionId`, `agentSessionRuntimeBindingId`, `turnId`, `leaseId` |
| `session.close` | `agentSessionId`, `agentSessionRuntimeBindingId` |
| `harness.drain` | no fields |

The two `turn.start` tokens are distinct 43-character raw values delivered only in that live dispatch response after their hashes and exact Turn lineage are durable. NanoCore's private Harness operation record and durable command identity contain only their hashes; the raw values remain only in the response-producing live scope. NanoHost forwards them without retention; Sandbox Integration binds them only to the named AgentSession and active Turn and clears them at the Turn barrier. Every `*Ref` is an already-materialized fixed sandbox-local reference selected by its owner, not a caller path, URL, credential, or content carrier. An extra, missing, unknown, malformed, oversized, sibling, stale, or conflicting field fails before a Harness effect.

Integration posts one result with exactly `schemaVersion`, `operationId`, `sequence`, `disposition`, and `body`. `disposition` is `succeeded`, `refused`, or `unknown`. A refusal body contains only `reasonCode` from `missing`, `stale`, `conflict`, `unsupported`, `busy`, `dependency_failed`, or `cleanup_required`; an unknown body is exactly `{ "reasonCode": "outcome_unknown" }`. A success body is operation-specific:

| Operation | Exact success-body fields |
| --- | --- |
| `session.open` | `state="open"`, `nativeHandleState="pending"|"ready"`, nullable lowercase 64-hex `nativeHandleDigest`, `maxActiveTurns=1` |
| `session.inspect` | `state="open"|"active"|"closing"|"closed"|"failed"`, `nativeHandleState="pending"|"ready"|"absent"|"unknown"`, nullable lowercase 64-hex `nativeHandleDigest`, `childState="absent"|"running"|"stopping"|"unknown"`, `cleanupState="clean"|"pending"|"unknown"` |
| `turn.start` | `state="started"`, `nativeHandleState="pending"|"ready"`, nullable lowercase 64-hex `nativeHandleDigest` |
| `turn.interrupt` | `state="interrupted"`, `childState="absent"` |
| `session.close` | `state="closed"`, `childState="absent"`, `privateState="absent"` |
| `harness.drain` | `state="draining"`, non-negative safe integer `openSessions`, non-negative safe integer `activeTurns` |

`turn.start` settles as soon as the exact AgentSession child process is running under supervision and its Turn-local route bindings are installed; it does not wait for native exit or `collectTurn`. A first Codex Turn returns `nativeHandleState="pending"` with a null digest, which leaves the next Harness sequence available for `turn.interrupt`. A later Turn may return `ready` only with the already-bound digest it is attempting to resume. After the first Turn reaches its terminal and collection barriers, `collectTurn` must establish the exact handle and a subsequent `session.inspect` must return `ready` with the same digest before NanoCore marks that binding reusable and idle. If the first Turn is interrupted, failed, or unknown, or terminal collection and inspection cannot prove one exact handle, the binding is non-reusable and proceeds to exact `session.close` or the existing wider cleanup fence.

Integration records the accepted `operationId`, sequence, canonical command fingerprint, and then the exact result in bounded Harness memory before any retry; it retains only the current or immediately settled operation and no queue or history. Exact result replay with the same identity, sequence, and canonical body is idempotent across outer-session or bridge reconnect. Changed same-identity result, stale or future sequence, or another operation while one is unsettled fails closed. NanoCore marks a command dispatched before returning its body and never redelivers a dispatched Harness effect; an incomplete delivery, accepted command without an Integration receipt, missing result after the existing outage bound, or lost Harness memory becomes `unknown`, stops admission, and widens cleanup without replay. A queued command not yet dispatched survives NanoCore restart through the private Harness record because it contains no raw route token; a dispatched command survives only as waiting-for-exact-result truth and never regains raw `turn.start` tokens or execution authority.

The Harness supervisor may retry only the same immutable poll or result request under the existing bounded route-outage budget. NanoHost and the Integration transport adapter do not retry it. After a predecessor-fenced bridge successor binds the same current Harness, Integration resumes at the exact unsettled sequence, first replays a retained result when one exists, and otherwise polls; a new or restarted Harness cannot adopt the old binding and requires drain, cleanup, and fresh admission.

### Operation-Specific Lifecycle

The Harness control boundary MUST NOT accept or derive caller-supplied arbitrary command text, executable, `argv`, `cwd`, environment, shell text, host path, provider endpoint, raw credential, working directory, runtime installation, or operation name outside the fixed set. A typed operation carries only the exact bounded fields its owner admits; an unknown operation or extra executable field fails closed before any Harness effect.

Lifecycle is `session.open`, zero or more sequential `turn.start` operations with optional exact `turn.interrupt`, then `session.close`; `session.inspect` is read-only proof and `harness.drain` is an admission fence. `session.open` creates one AgentSession-private adapter binding and state root only when the bound Thread has no other current resident AgentSession. When the pinned adapter creates its native conversation only with the first prompt, the open and first start results carry `nativeHandleState=pending`; the first successfully collected Turn plus subsequent exact `session.inspect` must bind and prove the native handle before that AgentSession becomes reusable. A later Turn may launch a new native process that resumes the same handle, but another AgentSession belongs to another Thread and has its own binding, state root, handle, child, route credentials, and cleanup proof. A Turn starts only after fresh admission and consumes one active-Turn lease; it ends through existing final-status, output, evidence, route-revocation, child-absence, collection, and cleanup barriers before another Turn may use that AgentSession.

Exact replay is permitted only where the owning operation defines an idempotent identity and proves that the prior effect is the same; an uncertain `session.open`, `turn.start`, `turn.interrupt`, or `session.close` MUST NOT be retried as a new operation or redirected to a compatible AgentSession. Missing, stale, conflicting, unsupported, or dependency-failed input returns a typed refusal without fallback. Restart adopts only an exact surviving binding and sequence under the NanoHost and AgentSession proof contracts; otherwise the Harness drains, cleanup widens as required, and later work begins through fresh NanoCore admission.

Failure of an AgentSession-local operation affects only that AgentSession when the Harness proves native context, child process, route, and file cleanup local. If that proof is absent, the Harness drains and the NanoHost owner fences the Harness, Sandbox, or Runtime Epoch boundary whose complete effect domain can be proved. No sibling result, terminal state, or successful cleanup is inferred.

Observable conformance requires AgentSessions for two distinct Threads to open through the fixed operations, two sequential Turns in each to receive distinct per-Turn packages and route credentials, a second current binding for one Thread to be rejected, an exact interrupt or close to target only its named AgentSession when local cleanup is proved, an unknown operation or executable field to cause zero Harness effect, and cleanup uncertainty to widen the fence before capacity returns.

### Interrupt Delivery Poll Cadence

Under pull-only delivery the dominant term in command-delivery latency is how long an enqueued command waits for the next poll, not transport time. The cadence is therefore a protocol requirement here rather than an implementation detail.

While a worker Turn is running and polling is not paused by a retryable outage, the interval between successive requests on the mode-selected interrupt poll MUST be at most 1000 ms, measured at Sandbox Integration from the issue of one poll request to the issue of the next. The selected poll is the worker command poll for `bounded-turn` and the private Harness poll for `session-continuity`; the other path is absent. The start-to-start anchor is normative because it is the only reading under which the cadence bounds an interrupt's wait: a delay measured from response receipt lets round-trip time silently extend the effective interval.

Jitter MAY only reduce the interval. Positive jitter, adaptive backoff, or any scheme that can exceed the maximum is invalid, because the maximum is exactly half of the end-to-end interrupt-delivery bound and has no headroom above it.

That bound is owned by `docs/specs/20260802-nanohost_runtime_and_transport.md` and is measured from the committed product interrupt authorization and mode-selected enqueue to shared-supervisor observation; the half not consumed by this cadence is what remains for transport under load. The transport owner MUST NOT raise its bound in a way that this cadence cannot satisfy, and this cadence MUST NOT be relaxed without that owner restating its bound.

A poll paused by a retryable outage does not violate the cadence; resumption restarts the interval. A paused interval still consumes the single bounded outage budget owned by the retry rules in Final Status, and the cadence creates no additional retry authority, no second poll stream, and no offline command queue.

The cadence governs only the selected interrupt-delivery poll. A `bounded-turn` worker MAY issue its heartbeat in the same request as its command poll; the private Harness poll has its exact separate body and never carries a heartbeat. Neither case makes the lease heartbeat interval owned by `docs/specs/20260703-runtime_scheduling_scale.md` equal to this cadence. That interval is a maximum staleness bound, not a target rate: heartbeating more often than it is permitted and heartbeating less often than this cadence is permitted when decoupled. An implementation that couples bounded-turn heartbeat and command polling accepts the higher request rate as its own cost.

If a backend push channel is ever added, it MUST deliver no slower than this cadence would, and it MUST return to this specification and the transport owner first, because pull-only delivery is what makes Sandbox Integration the transport client and a push path would invert that role assignment.

In `bounded-turn` mode, worker `interrupt` asks the shared supervisor to terminate the supervised process group and the worker acknowledges only after it has initiated that generic termination. In `session-continuity` mode, private `turn.interrupt` invokes that same supervisor and returns `succeeded` only after exact process-group absence; it returns `refused` when the terminal owner already won and `unknown` when absence cannot be proved. No native graceful-yield hook, double signal, cross-mode retry, or operation-result terminal state is part of either adapter contract.

After the readiness exchange, a retryable outage pauses the selected interrupt poll and starting queued interrupts. Bounded-turn interrupt commands replay only their acknowledgement; shared-Harness interrupt operations retain only their exact result under the private non-redelivery contract. The shim retains bounded raw replay data in memory for the current process and records only product-safe identity and digest evidence locally. An unknown repeated command or the same command or operation id with a different canonical payload fails closed; no general offline outbound queue is introduced.

A future supply refresh command may only be used when the resolved AEP declares support proved by the selected image and shared shim. V1 issues no live refresh request: same-snapshot lease renewal continues without refresh acknowledgement, while an incompatible AEP snapshot requires a new plan and lease after the current bounded step.

`shutdown`, `collect-and-stop`, and `health-check` remain future command families until they have a concrete protocol schema and implementation.

## Final Status

The shim must send one final status for each bounded worker step.

Final status includes:

- `status`
- product-safe `stopReason`
- final worker sequence
- transcript manifest digest
- artifact manifest digest
- workspace changes manifest digest
- capability summary ids
- audit summary ids when available
- error summary when failed

Valid `status` values:

- `completed`
- `interrupted`
- `cancelled`
- `failed`
- `blocked`
- `degraded`
- `lost`

NanoCore derives the canonical Core `StopReason` and Turn status through the Worker Turn Reliability Envelope after evidence collection; it does not rename the wire field or treat the transport value as product-state authority.

`final_status` is the worker's last durable-output barrier. Before sending it, the shim MUST seal the terminal transcript and runtime-provenance records and finish workspace-change publication for the bounded step. After NanoCore accepts it, that shim process MUST NOT publish more transcript, provenance, workspace-change, or artifact output for the step.

Accepted `final_status` is necessary but insufficient for file export. The shim and Harness must also prove the exact AgentSession-local native process group absent, including the mandatory post-KILL absence check when TERM/KILL is needed. The retained bootstrap monitor is a separate Sandbox-wide Harness-lifetime proof: it remains live through per-Turn export and must observe exactly one correlated Exit followed by clean response completion only when the Harness ends. A per-Turn export MUST NOT wait for or consume that monitor. If signal zero still addresses the local process group after the KILL bound, the shim emits neither a successful terminal status nor barrier-qualifying local absence proof. A nonzero local Exit without proved process-group absence, response loss, child survival, relay or member loss, or ambiguous cleanup blocks export and follows sandbox-delete and uncertain-delete epoch-fence truth. Missing or duplicate bootstrap-monitor Exit, unclean monitor completion, or monitor loss at Harness end follows the separate Sandbox-lifecycle failure contract. Closing or cancelling either interactive direction or either H2 connection is never termination proof.

NanoCore may accept `final_status` before it has collected all data-plane evidence. Acceptance means the worker has finished publishing its durable output, not that NanoCore has imported or approved it. The canonical turn cannot close until NanoCore has collected or intentionally marked missing required evidence.

After readiness and worker-child launch, a lost `final_status` response is retried only with the same logical operation identity, sequence, canonical payload, and remaining shared outage budget. Budget expiry does not start a best-effort final-status grace period; the shim writes its local terminal record, ends its children, and lets durable recovery project the interrupted outcome.

## End-To-End Control And Evidence Collection

The protocol supports end-to-end live append plus turn-end collection from `/openkit/session/*.jsonl`. Transcript collection is evidence and deduplication input, not a fallback control mode. Control is fail-fast until the complete readiness exchange succeeds and the supervised Worker Agent child starts. After child launch, a retryable route outage enters one shared five-minute monotonic outage budget. The worker-control client inside Sandbox Integration keeps the active Worker Agent child alive, pauses new command polling, and retries only the same immutable logical request every 250 ms within that budget. The Integration outer adapter, NanoHost transport, and other route families do not replay it. Exponential backoff, jitter, and `Retry-After` handling are not part of this contract.

NanoCore restart or short network loss does not cancel a locally accepted OpenShell operation and does not recreate the Sandbox. When the NanoHost transport returns, a successor connection first fences its predecessor, then worker control continues the same AgentSession, lease, package snapshot, backend session, process key, and exact next sequence. A late predecessor message is rejected and cannot advance control state.

HTTP 408, 425, 429, 500-599, request timeout, connection refusal/reset, broken pipe, temporary DNS, and temporary TLS/socket failures are retryable after readiness. Schema failure, 401, 403, 404, 409, 413, 422, any other non-retryable 4xx, invalid 2xx JSON, and an invalid success envelope are terminal authority or contract failures and stop the children immediately. String matching is not a normal classifier.

Local transcript append and remote live delivery are separate queues. A remote outage MUST NOT poison local append or prevent one terminal record from being sealed. Exact raw terminal output needed for a same-process retry may remain bounded in shim memory; the durable transcript stores only operation identity, canonical digest, and product-safe summary. Shim restart remains non-recoverable.

## Outage Tolerance Is Two Separate Guarantees

The bounded outage budget above is a worker-control guarantee and nothing more. It is routinely read as "a NanoCore outage does not disturb a running worker", which is false, and the two guarantees that actually exist have different values and must be stated separately.

**Control-plane tolerance** is the single bounded outage budget: a worker survives a NanoCore outage shorter than that budget without losing its lease, its sequence, or its process, and the execution runtime keeps its local state and its worker process alive for the duration.

**Inference availability during a NanoCore outage is zero.** Inference is routed through NanoCore to the provider, so a NanoCore outage of any duration makes `/inference/*` unavailable for exactly that duration. A worker that needs a model call during the outage stalls; it does not continue. "Local execution survives" therefore means the process, lease, and sequence survive, not that the agent makes progress.

Neither guarantee may be widened by moving authority downward. The execution runtime MUST NOT open a direct provider path, substitute a provider, serve a cached inference response, or otherwise make an inference effect happen while NanoCore is unreachable, because provider selection, policy, usage attribution, and audit are NanoCore-owned and an unattributed effect is worse than a stalled one.

A worker that exhausts its budget fails through the existing owners. The runtime MUST NOT extend the budget or the lease deadline to conceal an outage; only NanoCore may grant time, and only through the lease owner.

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

Failed verification stores quarantined evidence and does not promote records into product history.

Sequence gaps do not block live event append by default. NanoCore accepts higher valid event sequences, rejects stale lower sequences, and rejects same-sequence conflicting payloads. Missing sequence evidence may produce degraded import or recovery state when transcript collection proves required records are absent.

## Durable Worker-Control State

Worker-control state MUST survive NanoCore restart. Process-local gateway state is a bootstrapping projection only; the durable contract is:

- Token bindings are resolved through the durable session lease records owned by `docs/specs/20260703-durable_scheduler_design.md`. That existing owner stores exactly two nullable lowercase SHA-256 projections, one for the worker-control token and one for the inference token, and never either raw value. A family authenticator hashes the presented token and compares it to the exact current live lease/lineage binding; `stale`, fenced, terminal, or `releasing` lineage outside exact accepted `final_status` replay fails authentication and revokes both through the existing lease status owner. This discharges restart durability through the scheduler's records instead of a parallel credential store.
- Queued NanoCore-to-worker commands are durable server-scope SQLite rows carrying lineage, command family, payload, enqueue time, and delivery state (`queued`, `delivered`, `acknowledged`, `undeliverable`). On lease takeover or terminal transition, queued commands for the dead session MUST be drained to `undeliverable`, per the scheduler spec's takeover rules.
- The accepted-event high-watermark (last accepted worker sequence and its fingerprint) is durably recorded per AgentSession and package snapshot, so duplicate replay idempotency, stale-sequence rejection, and same-sequence conflict rejection hold across NanoCore restarts, not only within one process run.
- Accepted artifact notices are durable rows; heartbeat state is not separately persisted because the lease's heartbeat deadline timestamps own liveness truth.
- On restart, the worker-control and inference gateways rebuild their family-specific serving state from the two lease-owned token hashes, current AEP and lineage, command rows, and high-watermark rows during the boot phase defined by `docs/specs/20260704-nanocore_bootstrap_readiness.md`. The surviving NanoHost and exact AgentSession-local route boundary retain the same raw values, so successor carriage performs no token reissuance, Harness Start, Sandbox or AgentSession creation, or already-current bridge open. A request whose lease cannot be found or re-adopted is untracked execution and MUST be refused per the scheduler spec's orphan rules.
- An armed `awaiting-reconnect` lease may use only one exact-next heartbeat carrying its memory-only process key. Every other operation remains unauthorized until adoption commits. An adopted session immediately regains ordinary control even when another lease remains pending.
- After adoption commits, replay of the exact same sequence and fingerprint is ordinary idempotent success; rollback, gap, wrong-key replay, or same-sequence payload conflict is terminal.
- Interrupt acknowledgement uses the durable command row and canonical payload digest to accept an exact replay while rejecting a different payload under the same command id.

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

## Relationship To Agent Capability

Capability calls do not flow through the control plane.

The control plane may carry `capability_summary` notifications so NanoCore can update liveness or progress displays, but the authoritative capability call record belongs to Agent Capability.

Only `event_append` may create item-visible progress by default, and only after NanoCore validates and commits the candidate event record. Heartbeats, artifact notices, command polls, final status, and capability summaries are control records until NanoCore explicitly imports or projects them into product state.

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

## Resolved Decisions

- Command delivery is pull-only in the first implementation. Backend push is future work.
- Control does not carry large payloads. V1 numeric payload limits are accepted below, and oversized payload rejection is mandatory before broad remote deployment.
- Sequence gaps are allowed during live append; stale lower sequences and same-sequence conflicting payloads fail closed.
- `final_status` can be accepted before data-plane evidence collection, but it cannot close the canonical turn by itself.
- `event_append` is the only default item-visible progress path; every other control message family remains a control record unless NanoCore imports it.
- The canonical worker-visible contract is one AEP-resolved sandbox-local `/worker-control/*` Integration binding with typed operation envelopes and a worker-control-only token reference.
- The Harness adapter accepts only the six fixed typed operations above; no public or worker-visible route can select arbitrary executable instructions, and every `turn.start` carries a fresh per-Turn AEP and Context Package rather than Sandbox-wide authority.
- Harness delivery is an Integration-initiated two-path private pull protocol under `/worker-control/*`, authenticated by current nested-connection plus authoritative-NanoHost carriage and an injected non-secret `harnessBindingRef`; it accepts no bearer token, carries at most one sequenced operation, retains no general queue, and is distinct from both the eight NanoHost effects and per-Turn worker `interrupt` commands.
- Interrupt delivery is mode-exclusive: `bounded-turn` uses only the existing durable worker `interrupt` command row, while `session-continuity` uses only private Harness `turn.interrupt`; the existing Turn and lease terminal compare-and-set and shared process-group supervisor remain the single race and local-effect owners, and neither delivery path mirrors or falls back to the other.
- Worker-control and inference token-binding state is durable by contract: two separate lowercase SHA-256 projections resolve through scheduler lease records, queued commands and event high-watermarks remain their existing durable rows, and restart rebuilds serving state from those owners while raw tokens stay only with the surviving live path. No raw credential, shared token, or `sandboxBindingRef` derivation is durable.
- Restart reconnection uses the ordinary heartbeat route, one current schema, a per-process memory-only random key whose hash is bound at sequence zero, exact-next heartbeat adoption, and the existing durable control ledger. It adds no challenge protocol, recovery listener, alternate token, negotiated version, or compatibility path.
- Previously open questions are resolved by accepted V1 defaults: control envelopes are capped at 64 KiB, individual live event payloads are capped at 256 KiB, and any larger material must move through the data plane as an artifact, evidence bundle, manifest, or collected file reference with typed oversized-payload diagnostics.

Current implementation projection: `apps/nanocore/src/scheduler-records.ts` stores and restores distinct lease-owned lowercase SHA-256 worker-control and inference token bindings, verifies Workspace/Thread/Turn/AgentSession/package-snapshot lineage, and rejects stale, releasing, terminal, shared-token, wrong-family, or `sandboxBindingRef` authentication. Raw tokens remain only on the live path, and inference no longer reuses worker-control authentication. The lease owner also supports a live-to-`releasing` transition that preserves capacity until evidence collection completes. The scheduler dispatch helper derives the package snapshot id from the selected Turn and reserved AgentSession, keeping lease lineage aligned with AEP resolution. `apps/nanocore/src/runtime/worker-control-gateway.ts` registers the scheduler-owned binding, enforces the durable resolver, records supply refresh acknowledgements and capability summaries, enforces replay and sequence rules across every sequenced stream, and invokes the accepted-terminal hook. Server-scope sequence fingerprints preserve same-sequence conflict rejection across gateway instances. The App routes enforce the typed 64 KiB control-envelope and 256 KiB event limits, map accepted final status into canonical terminal evidence, retain future refresh acknowledgements without making them a V1 renewal requirement, quarantine rejected verification evidence, and hold the matching lease in `releasing` until the existing terminal owners finish. Active-AgentSession command enqueue accepts only `interrupt`, restart rebuild ignores acknowledged interrupts and every retired command kind, and governed launches use scheduler-owned lease lineage. The worker shim reaches these routes through Sandbox Integration over the stock bridge and nested HTTP/2; fixed unary bootstrap/response monitoring and the final-status, process-group-absence, Exit, and clean-response export barrier are implemented. The deleted Knowledge proposal-summary path remains absent. Live supply refresh and backend push remain separately gated future designs rather than missing V1 behavior.

The product-safe active-AgentSession projection resolves live worker-control state through the exact persisted Agent Environment Package snapshot. If that snapshot is not live or lineage is incomplete, the projection returns no control summary and command enqueue fails closed; it never borrows state from an older package or an AgentSession-only lookup. Exact lineage authorizes only the typed `interrupt` command.

## Deferred / Future Work

- Define explicit maximum payload size and rejection diagnostics for any future non-envelope control route before exposing it.
- Add backend push command delivery only after the pull protocol is stable.
- Define `shutdown`, `collect-and-stop`, and `health-check` command schemas if they are still needed.
- Define the source and target snapshot schema, runtime and shim support negotiation, atomic lease and token rebinding, idempotency, rollback, and audit evidence before issuing any live supply refresh request.
- Define a workspace-change notice only if workspace synchronization cannot be represented by artifact notices, manifests, and data-plane collection.

Deferred work is non-authorizing and creates no current schema, state, compatibility, implementation, runner, harness, or test requirement.

## Testing Strategy

- L1-L2 cover envelope bounds, distinct token and lineage rejection, two hash-only durable bindings, raw-token and process-key secrecy, exact-next adoption without token reissuance or relaunch, final-status ordering, mandatory group absence, one clean monitor Exit, and the rule that Sandbox Integration suggestions are not product truth.
- L1-L3 security coverage MUST prove that no App API, NanoCore route, gateway method, or Sandbox Integration interface accepts or executes a caller-supplied arbitrary worker command, `argv`, `cwd`, environment, or shell text.
- L1-L3 Harness coverage MUST prove the six-operation closed set, exact AgentSession and Turn targeting, per-Turn package and route separation as conversation-context isolation, read-only inspection, drain refusal, idempotent exact replay only, and wider fencing when local cleanup is unprovable; it MUST NOT infer security and adjudication isolation from those route checks.
- L1-L3 interrupt coverage MUST prove that one product interrupt authorization selects exactly one delivery owner by immutable adapter mode, terminal-first creates no delivery, interrupt-first creates no duplicate or direct product terminal, cross-mode rows and requests fail before signal, `bounded-turn` acknowledgement and shared-Harness result uncertainty never fall back to each other, and both invoke the same process-group supervisor.
- L1-L3 cadence coverage MUST prove that the selected worker command poll or private Harness poll stays within the 1000 ms start-to-start maximum throughout one active Turn under saturating permitted inference load, the unselected poll is absent, empty Harness polls wait at least 250 ms, retryable outage consumes only the existing shared budget, and end-to-end interrupt observation satisfies the NanoHost envelope.
- L1-L3 Harness carriage coverage MUST prove the two exact paths, no Authorization header, rejection of a client-supplied Harness binding, authoritative NanoHost injection, exact sequence and operation identity, one unsettled operation, dispatched-command non-redelivery, exact result replay, changed replay rejection, pre-AgentSession admission, and unknown-outcome widening without a ninth effect or worker command.
- L1-L3 Codex Harness coverage MUST prove two distinct Threads with independent AgentSession-private state roots and handles in one Sandbox, rejection of a second current AgentSession binding for one Thread, first `turn.start` settlement with a pending handle while `turn.interrupt` remains deliverable, terminal `collectTurn` plus `session.inspect` handle establishment before reuse, a later process instance resuming the same handle, sibling-handle rejection, one active Turn across the Harness, and exact close of one AgentSession without disturbing the other.
- Retry coverage proves one logical request is not re-executed within the bounded live-process outage budget; it need not enumerate every network error and instruction boundary.
- L3 reuses the scheduler's one deterministic NanoCore kill/restart scenario to prove predecessor-fenced exact adoption of the same worker and sequence or the interrupted fallback. Worker control does not own another restart runner.
- Real local or A1 acceptance reuses the existing stock OpenShell path only when transport integration cannot be proved below L5.
- No tests are required for backend push, general offline command delivery, replacement workers, multi-target failover, or other deferred command families.

## Risks & Mitigations

- Risk: Control becomes a backdoor shell. Mitigation: keep `interrupt` as the sole current command and require a separately accepted typed design before adding another family.
- Risk: Temporary NanoCore failure kills useful remote work. Mitigation: keep the original Integration-controlled child alive within the route-owned outage budget and require the successor NanoHost connection, exact memory-only process key, durable lineage, and next sequence before ordinary control resumes.
- Risk: A transport observer races the original worker because V1 has no server-fresh application challenge. Mitigation: require the authenticated confidential NanoHost transport plus predecessor fencing, keep the raw process key and both route tokens out of durable state and logs, retain only two family-specific hashes in the exact lease owner, and fail closed on any connection, key, token family, lineage, sequence, or deadline mismatch.
- Risk: Recovery replay duplicates an external effect. Mitigation: use one logical identity and digest per heartbeat, interrupt acknowledgement, and final status; exact replay succeeds and any conflict fails closed.
- Risk: Sandbox Integration becomes a second Core. Mitigation: Sandbox Integration emits suggestions and evidence; NanoCore verifies and commits.
- Risk: Remote and local containers diverge. Mitigation: keep the same worker-visible endpoint and envelope for both placements.

## Links

- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260704-nanocore_bootstrap_readiness.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/core/communication.md`
- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260702-knowledge_store_governance_rules.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
