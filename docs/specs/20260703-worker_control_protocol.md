# Worker Control Protocol

Status: Accepted
Implementation: Partial

## Summary

This spec defines `openkit-worker-control-v1`, the minimal control protocol between governed worker containers and NanoCore.

The clean target is narrow: control is for session liveness, candidate event append, final status, the typed interrupt command, and small notifications. It is not an agent capability gateway projection, shell gateway, file-transfer channel, product-state API, or replacement for workspace review.

V1 serves the current one-process, one-configured-target, one-active-worker-slot deployment profile. It preserves one bounded same-worker reconnect after NanoCore restart; it does not provide general offline operation, worker replacement, transparent failover, or distributed control availability.

## Owns

- The worker-visible control-plane protocol between a governed worker shim and NanoCore.
- Control-plane lineage, sequence, authentication, idempotency, retry, and verification rules.
- Worker-to-NanoCore liveness, candidate event append, final status, artifact notice, capability summary, and knowledge proposal notification semantics.
- NanoCore-to-worker delivery semantics for the typed interrupt command.
- The rule that worker-control records become product-visible only after NanoCore verification.
- Direct control delivery and local session-file evidence requirements.

## Does Not Own

- Agent Capability calls for LLM, MCP, tools, network, credentials, context, usage, or rate limits.
- Large artifact transfer, patch transfer, raw transcript transfer, or workspace snapshot transfer.
- Product item schemas, turn log storage, audit ledgers, metering ledgers, or workspace review records.
- Runtime-native transcript parsing rules.
- Deployment-specific reachability mechanics beyond the worker-visible protocol contract.

## Core References

- `docs/core/communication.md`
- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-workflow.md`
- `docs/core/agent-capability.md`
- `docs/core/audit.md`
- `docs/core/metering.md`

## Goals

- Define the worker-visible control endpoint.
- Define request lineage, sequence, idempotency, and authentication requirements.
- Define worker-to-NanoCore messages and NanoCore-to-worker commands.
- Support mandatory direct delivery while retaining transcript evidence on the data plane.
- Keep the worker shim subordinate to NanoCore canonical verification.

## Non-goals

- Do not carry large artifacts, patches, bundles, or raw logs over the control plane.
- Do not expose arbitrary shell execution.
- Do not let the shim mutate product state directly.
- Do not duplicate capability calls; the future `capability.local` plane owns privileged services.
- Do not define runtime-native transcript parsing in this spec.
- Do not add a general offline command queue, replacement-worker protocol, multi-target failover, settlement workflow, or feature-specific recovery harness.

## Background

`docs/specs/20260629-worker_runtime_communication_model.md` requires every real worker container to run the OpenKit worker shim and use its AEP-resolved direct NanoCore `/api/worker-control` endpoint.

The missing design is the concrete protocol boundary and message family.

## Current Implementation Projection

The current implementation is a partial projection of this contract:

- `packages/worker-protocol` owns the shared schema vocabulary for worker lineage, schema-conformant candidate event records, worker-control operation names, and bounded request/response envelopes.
- `packages/worker-shim` owns the sandbox-side direct control client. It sends bearer-authenticated requests to the AEP-resolved NanoCore endpoint.
- `apps/nanocore/src/runtime/worker-control-gateway.ts` owns the process-local gateway state for one registered Agent Environment Package snapshot: sandbox token or scheduler-owned sandbox binding ref, heartbeat, artifact notices, interrupt commands, supply refresh acknowledgements, capability summaries, knowledge proposal summaries, accepted events, and product-safe snapshots. The default server gateway persists accepted worker-control records into `worker_control_records`, interrupt delivery state into `worker_control_commands`, quarantined verification failures into `worker_control_rejected_evidence`, and restores live lease-backed sessions from durable rows on process startup.
- `apps/nanocore/src/app.ts` projects the gateway as `/api/worker-control/heartbeat`, `/api/worker-control/artifacts`, `/api/worker-control/commands/poll`, `/api/worker-control/commands/ack`, `/api/worker-control/events/append`, `/api/worker-control/final-status`, `/api/worker-control/supply-refresh-ack`, `/api/worker-control/capability-summary`, and `/api/worker-control/knowledge-proposal-summary`.
- Tests cover token binding, lineage checks, heartbeat recording, artifact notices, interrupt polling and acknowledgement, candidate event append, the 64 KiB typed control-envelope cap, the 256 KiB live event append cap, process-local sequence replay handling for heartbeat, artifact notice, supply-refresh acknowledgement, capability summary, and knowledge-proposal summary streams, durable sequence-fingerprint replay checks for the default server gateway, durable accepted-record writes for default server heartbeat and event append routes, durable interrupt transitions from queued to delivered to acknowledged, rejected-evidence quarantine for gateway verification failures, and live lease-backed gateway rebuild from durable rows. Restart rebuild restores only unacknowledged `interrupt` rows; acknowledged interrupts and retired command kinds remain inert. Duplicate replay idempotency, stale sequence rejection, and conflicting same-sequence rejection are implemented and tested for the `event_append` channel and the other sequenced control streams, with server-scope durable fingerprint checks preserving same-sequence conflict rejection across default gateway instances.

The former App API arbitrary-command issuer, caller-selected `argv` and `cwd` shape, terminal-result route, gateway state, and shared-shim executor are deleted end to end. `interrupt` is the only current worker-control command.

The active restart slice adds one shared bounded retry loop in the shim, a memory-only worker process key, and exact-next heartbeat adoption through the ordinary heartbeat route. NanoCore binds only the key hash to the lease, and direct terminal closeout reuses accepted final-status, backend-session, lease, checkpoint, and workspace records. Full data-plane evidence promotion remains outside this spec and is owned by the workspace synchronization, worker runtime communication, audit, evidence, and review specs.

## Endpoint

The worker-visible endpoint is:

```text
<AEP-resolved HTTP(S) NanoCore base URL ending in /api/worker-control>
```

The endpoint is the exact worker-reachable NanoCore URL selected during AEP resolution. It must be credential-free, use HTTP or HTTPS, and end in `/api/worker-control` after trailing-slash normalization.

The worker shim appends the operation-specific path to that base URL. OpenShell service forwarding, a sandbox-local alias, a backend relay, a capability gateway, or a transcript sink is not an alternate control path.

## Authentication

Every request must authenticate with a sandbox session token minted for one AEP snapshot.

The token is scoped to:

- workspace id
- thread id when applicable
- turn id
- agent session id
- package snapshot id
- backend session id or redacted backend session binding
- expiration time

NanoCore must reject token reuse across lineage.

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

`lineage` includes the workspace, thread, turn, agent session, package snapshot, backend session binding when applicable, and token scope needed to bind the request to one governed worker execution.

`sequence` is monotonic per agent session and package snapshot for the relevant control stream. Exact retries with the same sequence and identical canonical payload are idempotent. The same sequence with different content must fail closed. Lower stale sequences must fail closed after a higher event sequence has been accepted.

The canonical control response envelope is:

```text
schemaVersion
accepted
nextExpectedSequence
diagnostics
```

HTTP route-specific projections may put lineage and payload fields directly in route bodies, but they must preserve the same semantics: bounded payload, bearer token, lineage binding, monotonic sequence where the operation is sequenced, and NanoCore-owned verification.

Restart adoption uses the ordinary heartbeat envelope plus request-only `reconnectKey`. NanoCore decodes and hashes the key, then authorizes adoption only when the hash equals the immutable lease binding, the complete durable lineage is exact, the lease is still `awaiting-reconnect` before its preserved deadline, and the heartbeat sequence is exactly the next sequence after the last accepted heartbeat. The adoption compare-and-set advances the sequence and returns the lease to ordinary control; rollback, gaps, conflicting replay, a wrong key, or an expired window fail closed. The raw key is excluded from the canonical heartbeat fingerprint, access logs, diagnostics, and durable records.

There is no application-layer challenge, asymmetric signature, recovery listener, or recovery session state machine. The reconnect request relies on the same trusted TLS or operator-managed SSH transport that protects the sandbox bearer token. A party that can observe both credentials on that transport could race the original worker; deployment transport confidentiality is therefore an explicit boundary of this V1 compromise rather than something duplicated with a second cryptographic protocol.

If exact adoption does not complete inside the bounded window, worker control authorizes no compatible replacement and makes no completion claim. Existing scheduler and Cell cleanup terminate the old authority, and the owning Turn remains interrupted or `recovery_required` until a new request is authorized.

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
- `knowledge_proposal_summary`

`heartbeat` reports worker liveness and coarse lifecycle state. It must not carry transcript content.

`event_append` carries small schema-conformant candidate event records only. Large transcript files remain in `/openkit/session` and are collected through the data plane. NanoCore validation and commit, not append acceptance alone, makes product state canonical.

`artifact_notice` announces an artifact path, title, media type, digest when available, and collection hint. It does not upload artifact bytes.

`command_poll` is the worker's pull-based request for pending NanoCore commands.

`command_ack` acknowledges delivery handling for interrupt commands.

`final_status` records the worker's final bounded-step status and evidence manifest digests. Its `status` and product-safe `stopReason` string are worker-control transport facts rather than Core `StopReason` authority. The sole durable owner is the existing immutable server-scope `worker_control_records` row with `operation=final_status`, keyed by Agent Session, package snapshot, operation, and decimal sequence record key and validated against the row's exact Workspace, Thread, Turn, nullable request, lease, Agent Session, package snapshot, sequence, and canonical terminal-event lineage. The row stores the complete accepted wire payload plus `acceptedAt`; exact fingerprint replay reuses it and changed same-sequence input conflicts. It survives restart, is not Workspace-portable product history, and MUST NOT be copied into a checkpoint, evidence row, or recovery lifecycle. NanoCore then applies the one closed canonicalization table owned by the Worker Turn Reliability Envelope before mode closeout. An unknown or incompatible pair remains durable and yields `recovery_required`; NanoCore does not infer a Core reason from the product Turn projection or adapter-private vocabulary.

`supply_refresh_ack` acknowledges one explicit NanoCore-issued source-to-target supply refresh request only when the resolved AEP declares support proved by the selected image and shared shim. It never gates or acknowledges same-snapshot lease renewal.

`capability_summary` reports control-plane liveness and summary ids for capability activity. Authoritative capability call records belong to Agent Capability.

`knowledge_proposal_summary` reports proposed Knowledge Store changes. NanoCore decides whether to import them as governed knowledge proposals.

## NanoCore-To-Worker Commands

Current implemented command family:

- `interrupt`

Commands are delivered by worker polling in the first implementation. A backend push channel may be added later only if it preserves the same authorization, lineage, sequence, and delivery semantics.

`interrupt` asks the shared supervisor to terminate the supervised process group. The worker acknowledges only after it has initiated that generic termination; no native graceful-yield hook is part of the current adapter contract.

After the readiness exchange, a retryable outage pauses command polling and starting queued interrupts. Interrupt commands replay only their acknowledgement. The shim retains bounded raw replay data in memory for the current process and records only product-safe identity and digest evidence locally. An unknown repeated command or the same command id with a different canonical payload fails closed; no general offline outbound queue is introduced.

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

NanoCore may accept `final_status` before it has collected all data-plane evidence. Acceptance means the worker has finished publishing its durable output, not that NanoCore has imported or approved it. The canonical turn cannot close until NanoCore has collected or intentionally marked missing required evidence.

After readiness and worker-child launch, a lost `final_status` response is retried only with the same logical operation identity, sequence, canonical payload, and remaining shared outage budget. Budget expiry does not start a best-effort final-status grace period; the shim writes its local terminal record, ends its children, and lets durable recovery project the interrupted outcome.

## Direct Control And Evidence Collection

The protocol supports direct live append plus turn-end collection from `/openkit/session/*.jsonl`. Transcript collection is evidence and deduplication input, not a fallback control mode. Control is fail-fast until the complete readiness exchange succeeds and the supervised worker Agent child starts. After child launch, retryable control failure enters one shared five-minute monotonic outage budget. The shim keeps the active worker child alive, pauses new command polling, and retries the same immutable logical request every 250 ms within that budget. Exponential backoff, jitter, and `Retry-After` handling are not part of this contract.

HTTP 408, 425, 429, 500-599, request timeout, connection refusal/reset, broken pipe, temporary DNS, and temporary TLS/socket failures are retryable after readiness. Schema failure, 401, 403, 404, 409, 413, 422, any other non-retryable 4xx, invalid 2xx JSON, and an invalid success envelope are terminal authority or contract failures and stop the children immediately. String matching is not a normal classifier.

Local transcript append and remote live delivery are separate queues. A remote outage MUST NOT poison local append or prevent one terminal record from being sealed. Exact raw terminal output needed for a same-process retry may remain bounded in shim memory; the durable transcript stores only operation identity, canonical digest, and product-safe summary. Shim restart remains non-recoverable.

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

## Durable Control Session State

Worker-control state MUST survive NanoCore restart. Process-local gateway state is a bootstrapping projection only; the durable contract is:

- Token bindings are resolved through the durable session lease records owned by `docs/specs/20260703-durable_scheduler_design.md`. A control request authenticates by looking up the lease that owns its token binding; a lease in `stale`, `releasing`, or terminal state fails authentication. This discharges token-binding durability through the scheduler's records instead of a parallel store.
- Queued NanoCore-to-worker commands are durable server-scope SQLite rows carrying lineage, command family, payload, enqueue time, and delivery state (`queued`, `delivered`, `acknowledged`, `undeliverable`). On lease takeover or terminal transition, queued commands for the dead session MUST be drained to `undeliverable`, per the scheduler spec's takeover rules.
- The accepted-event high-watermark (last accepted worker sequence and its fingerprint) is durably recorded per agent session and package snapshot, so duplicate replay idempotency, stale-sequence rejection, and same-sequence conflict rejection hold across NanoCore restarts, not only within one process run.
- Accepted artifact notices are durable rows; heartbeat state is not separately persisted because the lease's heartbeat deadline timestamps own liveness truth.
- On restart, the worker-control gateway rebuilds its serving state entirely from lease records, command rows, and high-watermark rows during the boot phase defined by `docs/specs/20260704-nanocore_bootstrap_readiness.md`. A control request from a worker whose lease cannot be found or re-adopted is untracked execution and MUST be refused per the scheduler spec's orphan rules.
- An armed `awaiting-reconnect` lease may use only one exact-next heartbeat carrying its memory-only process key. Every other operation remains unauthorized until adoption commits. An adopted session immediately regains ordinary control even when another lease remains pending.
- After adoption commits, replay of the exact same sequence and fingerprint is ordinary idempotent success; rollback, gap, wrong-key replay, or same-sequence payload conflict is terminal.
- Interrupt acknowledgement uses the durable command row and canonical payload digest to accept an exact replay while rejecting a different payload under the same command id.

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

Only `event_append` may create item-visible progress by default, and only after NanoCore validates and commits the candidate event record. Heartbeats, artifact notices, command polls, final status, capability summaries, and knowledge proposal summaries are control records until NanoCore explicitly imports or projects them into product state.

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
- The canonical worker-visible contract is one AEP-resolved direct NanoCore `/api/worker-control` base URL with typed operation envelopes.
- Worker-control state is durable by contract: token bindings resolve through scheduler lease records, queued commands and event high-watermarks are durable rows, and restart rebuilds serving state from those records (see Durable Control Session State). The current process-local gateway state is an implementation projection that the durable scheduler change replaces.
- Restart reconnection uses the ordinary heartbeat route, one current schema, a per-process memory-only random key whose hash is bound at sequence zero, exact-next heartbeat adoption, and the existing durable control ledger. It adds no challenge protocol, recovery listener, alternate token, negotiated version, or compatibility path.
- Previously open questions are resolved by accepted V1 defaults: control envelopes are capped at 64 KiB, individual live event payloads are capped at 256 KiB, and any larger material must move through the data plane as an artifact, evidence bundle, manifest, or collected file reference with typed oversized-payload diagnostics.

Current implementation projection: `apps/nanocore/src/scheduler-records.ts` now has a durable lease token-binding resolver that looks up `sandbox_binding_ref`, verifies workspace/thread/turn/agent-session/package-snapshot lineage, and rejects stale, releasing, or terminal leases. It also supports a live-to-`releasing` transition that preserves capacity until evidence collection completes. The scheduler dispatch helper can derive the package snapshot id from the selected turn and reserved agent session id, keeping lease lineage aligned with the AEP resolver. `apps/nanocore/src/runtime/worker-control-gateway.ts` authenticates through process-local `registerSession` state, can register a scheduler-owned `sandboxBindingRef` as the worker token, can enforce an injected durable token-binding resolver for registered sessions, records supply refresh acknowledgements, capability summaries, and knowledge proposal summaries, enforces idempotent replay, same-sequence conflict rejection, and stale-sequence rejection for heartbeat, artifact notice, supply-refresh acknowledgement, capability summary, knowledge-proposal summary, and event-append streams, and calls an accepted-terminal-event hook when a `turn.completed` or `turn.failed` canonical event is accepted. `apps/nanocore/src/runtime/worker-control-sequences.ts` records server-scope sequence fingerprints in `worker_control_sequence_fingerprints` through migration `0025_worker_control_sequences`, and the default server gateway uses that recorder so same-sequence conflicting event and control payloads fail across default gateway instances, not only within one process-local map. `apps/nanocore/src/app.ts` wires the default worker-control gateway to the durable scheduler resolver for `lease-binding:` tokens, wires the same default gateway to the durable sequence recorder when a Core database is available, exposes `POST /api/worker-control/final-status`, `POST /api/worker-control/supply-refresh-ack`, `POST /api/worker-control/capability-summary`, and `POST /api/worker-control/knowledge-proposal-summary` as typed `WorkerControlRequestEnvelope` routes, rejects those typed control envelopes above 64 KiB with `worker_control_payload_too_large`, rejects `/api/worker-control/events/append` requests above 256 KiB with the same diagnostic before schema handling, maps `completed` final status to `turn.completed`, maps every other accepted final-status outcome to `turn.failed`, and persists accepted supply-refresh acknowledgements into `scheduler_supply_refresh_declarations` through migration `0027_scheduler_supply_refresh_declarations` as evidence for a future explicit refresh request. The current scheduler does not issue that request and does not read acknowledgement state for same-snapshot renewal. The route also writes product-safe rejected gateway verification evidence to `worker_control_rejected_evidence` through migration `0030_worker_control_rejected_evidence`, imports knowledge proposal summaries as pending app-local knowledge proposals for human review, and marks the matching live lease `releasing` with release reason `worker-final-status` when a terminal canonical event arrives. `apps/nanocore/src/runtime/orchestrator.ts`, `apps/nanocore/src/runtime/types.ts`, and `apps/nanocore/src/runtime/worker-governance-turn-executor.ts` let turn startup pass optional scheduler-owned agent-session and binding refs into backend materialization, and `apps/nanocore/src/runtime/worker-governance-backend.ts` can pass that binding ref into OpenShell worker-control registration. Active-session command enqueue accepts only `interrupt`, and restart rebuild ignores acknowledged interrupts and every retired command kind. Static placement still uses process-local random tokens until scheduler dispatch supplies lease lineage to turn execution.

The product-safe active-session projection resolves live worker-control state through the exact persisted Agent Environment Package snapshot. If that snapshot is not live or lineage is incomplete, the projection returns no control summary and command enqueue fails closed; it never borrows state from an older package or an agent-session-only lookup. Exact lineage authorizes only the typed `interrupt` command.

## Deferred / Future Work

- Define explicit maximum payload size and rejection diagnostics for any future non-envelope control route before exposing it.
- Add backend push command delivery only after the pull protocol is stable.
- Define `shutdown`, `collect-and-stop`, and `health-check` command schemas if they are still needed.
- Define the source and target snapshot schema, runtime and shim support negotiation, atomic lease and token rebinding, idempotency, rollback, and audit evidence before issuing any live supply refresh request.
- Define a workspace-change notice only if workspace synchronization cannot be represented by artifact notices, manifests, and data-plane collection.

Deferred work is non-authorizing and creates no current schema, state, compatibility, implementation, runner, harness, or test requirement.

## Testing Strategy

- L1-L2 cover envelope bounds, token and lineage rejection, monotonic sequence and same-sequence conflict, process-key secrecy, exact-next adoption, final-status ordering, and the rule that shim suggestions are not product truth.
- L1-L3 security coverage MUST prove that no App API, NanoCore route, gateway method, or worker shim accepts or executes a caller-supplied arbitrary worker command, `argv`, `cwd`, environment, or shell text.
- Retry coverage proves one logical request is not re-executed within the bounded live-process outage budget; it need not enumerate every network error and instruction boundary.
- L3 reuses the scheduler's one deterministic kill/restart scenario to prove exact adoption or the interrupted fallback. Worker control does not own another restart runner.
- Real local or A1 acceptance reuses the existing stock OpenShell path only when transport integration cannot be proved below L5.
- No tests are required for backend push, general offline command delivery, replacement workers, multi-target failover, or other deferred command families.

## Risks & Mitigations

- Risk: Control becomes a backdoor shell. Mitigation: keep `interrupt` as the sole current command and require a separately accepted typed design before adding another family.
- Risk: Temporary NanoCore failure kills useful remote work. Mitigation: keep the original shim-controlled child alive only within one shared bounded outage budget and require the exact memory-only process key, durable lineage, and next sequence before ordinary control resumes.
- Risk: A transport observer races the original worker because V1 has no server-fresh application challenge. Mitigation: require trusted TLS or the declared operator-managed SSH transport, keep the raw process key and bearer token out of durable state and logs, and fail closed on any key, lineage, sequence, or deadline mismatch.
- Risk: Recovery replay duplicates an external effect. Mitigation: use one logical identity and digest per heartbeat, interrupt acknowledgement, and final status; exact replay succeeds and any conflict fails closed.
- Risk: Shim becomes a second Core. Mitigation: the shim emits suggestions and evidence; NanoCore verifies and commits.
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
- `docs/specs/20260702-knowledge_store_governance_rules.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
