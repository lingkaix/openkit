# Worker Control Protocol

Status: Accepted
Implementation: Implemented

## Summary

This spec defines `openkit-worker-control-v1`, the minimal control protocol between governed worker containers and NanoCore.

The clean target is narrow: control is for session liveness, canonical event append, final status, safe commands, and small notifications. It is not an agent capability gateway projection, shell gateway, file-transfer channel, product-state API, or replacement for workspace review.

## Owns

- The worker-visible control-plane protocol between a governed worker shim and NanoCore.
- Control-plane lineage, sequence, authentication, idempotency, retry, and verification rules.
- Worker-to-NanoCore liveness, event append, final status, artifact notice, terminal result, capability summary, and knowledge proposal notification semantics.
- NanoCore-to-worker command delivery semantics for interrupts and allowlisted terminal diagnostics.
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

## Background

`docs/specs/20260629-worker_runtime_communication_model.md` requires every real worker container to run the OpenKit worker shim and use its AEP-resolved direct NanoCore `/api/worker-control` endpoint.

The missing design is the concrete protocol boundary and message family.

## Current Implementation Projection

The current implementation is the accepted V1 projection of this contract:

- `packages/worker-protocol` owns the shared schema vocabulary for worker lineage, canonical event records, worker-control operation names, and bounded request/response envelopes.
- `packages/worker-shim` owns the sandbox-side direct control client. It sends bearer-authenticated requests to the AEP-resolved NanoCore endpoint.
- `apps/nanocore/src/runtime/worker-control-gateway.ts` owns the process-local gateway state for one registered Agent Environment Package snapshot: sandbox token or scheduler-owned sandbox binding ref, heartbeat, artifact notices, queued commands, terminal results, supply refresh acknowledgements, capability summaries, knowledge proposal summaries, accepted events, and product-safe snapshots. The default server gateway persists accepted worker-control records into `worker_control_records`, command delivery state into `worker_control_commands`, quarantined verification failures into `worker_control_rejected_evidence`, and restores live lease-backed sessions from durable rows on process startup.
- `apps/nanocore/src/app.ts` projects the gateway as `/api/worker-control/heartbeat`, `/api/worker-control/artifacts`, `/api/worker-control/commands/poll`, `/api/worker-control/commands/ack`, `/api/worker-control/terminal-results`, `/api/worker-control/events/append`, `/api/worker-control/final-status`, `/api/worker-control/supply-refresh-ack`, `/api/worker-control/capability-summary`, and `/api/worker-control/knowledge-proposal-summary`.
- Tests cover token binding, lineage checks, heartbeat recording, artifact notices, pull command delivery, non-terminal command acknowledgement, terminal results, canonical event append, the 64 KiB typed control-envelope cap, the 256 KiB live event append cap, the 1 MiB terminal diagnostic cap, process-local sequence replay handling for heartbeat, artifact notice, supply-refresh acknowledgement, capability summary, and knowledge-proposal summary streams, durable sequence-fingerprint replay checks for the default server gateway, durable accepted-record writes for default server heartbeat and event append routes, durable command delivery state transitions from queued to delivered to acknowledged for both terminal and non-terminal commands, rejected-evidence quarantine for gateway verification failures, and live lease-backed gateway rebuild from durable rows. Duplicate replay idempotency, stale sequence rejection, and conflicting same-sequence rejection are implemented and tested for the `event_append` channel and the other sequenced control streams, with server-scope durable fingerprint checks preserving same-sequence conflict rejection across default gateway instances.

The implementation now covers the control-plane contract this spec owns. Full data-plane evidence promotion remains outside this spec and is owned by the workspace synchronization, worker runtime communication, audit, evidence, and review specs.

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

## Worker-To-NanoCore Messages

Control operation names:

- `heartbeat`
- `artifact_notice`
- `command_poll`
- `command_ack`
- `terminal_result`
- `event_append`
- `final_status`
- `supply_refresh_ack`
- `capability_summary`
- `knowledge_proposal_summary`

`heartbeat` reports worker liveness and coarse lifecycle state. It must not carry transcript content.

`event_append` carries small canonical event records only. Large transcript files remain in `/openkit/session` and are collected through the data plane.

`artifact_notice` announces an artifact path, title, media type, digest when available, and collection hint. It does not upload artifact bytes.

`command_poll` is the worker's pull-based request for pending NanoCore commands.

`command_ack` acknowledges delivery handling for non-terminal NanoCore commands such as interrupts.

`terminal_result` reports the bounded result of a NanoCore-issued terminal diagnostic command. It is not an arbitrary shell transcript channel.

`final_status` records the worker's final bounded-step outcome and evidence manifest digests. NanoCore may compute the canonical turn outcome differently after evidence collection.

`supply_refresh_ack` acknowledges one explicit NanoCore-issued source-to-target supply refresh request only when the runtime adapter and shim both declare safe refresh support. It never gates or acknowledges same-snapshot lease renewal.

`capability_summary` reports control-plane liveness and summary ids for capability activity. Authoritative capability call records belong to Agent Capability.

`knowledge_proposal_summary` reports proposed Knowledge Store changes. NanoCore decides whether to import them as governed knowledge proposals.

## NanoCore-To-Worker Commands

Current command families:

- `interrupt`
- `terminal-command`

Commands are delivered by worker polling in the first implementation. A backend push channel may be added later only if it preserves the same authorization, lineage, sequence, and delivery semantics.

`interrupt` asks the worker to stop or yield at the nearest safe point.

`terminal-command` is for tightly controlled diagnostics and must carry policy decision context. It is not a generic shell gateway.

A future supply refresh command may only be used when the runtime adapter and shim declare safe refresh support. V1 issues no live refresh request: same-snapshot lease renewal continues without refresh acknowledgement, while an incompatible AEP snapshot requires a new plan and lease after the current bounded step.

`shutdown`, `collect-and-stop`, and `health-check` remain future command families until they have a concrete protocol schema and implementation.

## Final Status

The shim must send one final status for each bounded worker step.

Final status includes:

- outcome
- stop reason
- final worker sequence
- transcript manifest digest
- artifact manifest digest
- workspace changes manifest digest
- capability summary ids
- audit summary ids when available
- error summary when failed

Valid outcomes:

- `completed`
- `interrupted`
- `cancelled`
- `failed`
- `blocked`
- `degraded`
- `lost`

NanoCore may compute the canonical turn outcome differently after evidence collection.

NanoCore may accept `final_status` before all data-plane evidence is collected. Acceptance only means the worker has reported its local bounded-step stop state. The canonical turn cannot close until NanoCore has collected or intentionally marked missing required evidence.

## Direct Control And Evidence Collection

The protocol supports direct live append plus turn-end collection from `/openkit/session/*.jsonl`. Transcript collection is evidence and deduplication input, not a fallback control mode. If direct control fails, the shim must stop or cancel the worker and preserve any local session files already written; NanoCore collects and verifies those files before closing the worker turn.

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
- Artifact notices and terminal results that have been accepted are durable rows; heartbeat state is not separately persisted because the lease's heartbeat deadline timestamps own liveness truth.
- On restart, the worker-control gateway rebuilds its serving state entirely from lease records, command rows, and high-watermark rows during the boot phase defined by `docs/specs/20260704-nanocore_bootstrap_readiness.md`. A control request from a worker whose lease cannot be found or re-adopted is untracked execution and MUST be refused per the scheduler spec's orphan rules.

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

Only `event_append` may create item-visible progress by default, and only after NanoCore validates the canonical event record. Heartbeats, artifact notices, command polls, terminal results, final status, capability summaries, and knowledge proposal summaries are control records until NanoCore explicitly imports or projects them into product state.

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
- Previously open questions are resolved by accepted V1 defaults: control envelopes are capped at 64 KiB, individual live event payloads are capped at 256 KiB, terminal diagnostic payloads are capped at 1 MiB, and any larger material must move through the data plane as an artifact, evidence bundle, manifest, or collected file reference with typed oversized-payload diagnostics.

Current implementation projection: `apps/nanocore/src/scheduler-records.ts` now has a durable lease token-binding resolver that looks up `sandbox_binding_ref`, verifies workspace/thread/turn/agent-session/package-snapshot lineage, and rejects stale, releasing, or terminal leases. It also supports a live-to-`releasing` transition that preserves capacity until evidence collection completes. The scheduler dispatch helper can derive the package snapshot id from the selected turn and reserved agent session id, keeping lease lineage aligned with the AEP resolver. `apps/nanocore/src/runtime/worker-control-gateway.ts` authenticates through process-local `registerSession` state, can register a scheduler-owned `sandboxBindingRef` as the worker token, can enforce an injected durable token-binding resolver for registered sessions, records supply refresh acknowledgements, capability summaries, and knowledge proposal summaries, enforces idempotent replay, same-sequence conflict rejection, and stale-sequence rejection for heartbeat, artifact notice, supply-refresh acknowledgement, capability summary, knowledge-proposal summary, and event-append streams, and calls an accepted-terminal-event hook when a `turn.completed` or `turn.failed` canonical event is accepted. `apps/nanocore/src/runtime/worker-control-sequences.ts` records server-scope sequence fingerprints in `worker_control_sequence_fingerprints` through migration `0025_worker_control_sequences`, and the default server gateway uses that recorder so same-sequence conflicting event and control payloads fail across default gateway instances, not only within one process-local map. `apps/nanocore/src/app.ts` wires the default worker-control gateway to the durable scheduler resolver for `lease-binding:` tokens, wires the same default gateway to the durable sequence recorder when a Core database is available, exposes `POST /api/worker-control/final-status`, `POST /api/worker-control/supply-refresh-ack`, `POST /api/worker-control/capability-summary`, and `POST /api/worker-control/knowledge-proposal-summary` as typed `WorkerControlRequestEnvelope` routes, rejects those typed control envelopes above 64 KiB with `worker_control_payload_too_large`, rejects `/api/worker-control/events/append` requests above 256 KiB with the same diagnostic before schema handling, rejects `/api/worker-control/terminal-results` requests above 1 MiB with the same diagnostic before schema handling, maps `completed` final status to `turn.completed`, maps every other accepted final-status outcome to `turn.failed`, and persists accepted supply-refresh acknowledgements into `scheduler_supply_refresh_declarations` through migration `0027_scheduler_supply_refresh_declarations` as evidence for a future explicit refresh request. The current scheduler does not issue that request and does not read acknowledgement state for same-snapshot renewal. The route also writes product-safe rejected gateway verification evidence to `worker_control_rejected_evidence` through migration `0030_worker_control_rejected_evidence`, imports knowledge proposal summaries as pending app-local knowledge proposals for human review, and marks the matching live lease `releasing` with release reason `worker-final-status` when a terminal canonical event arrives. `apps/nanocore/src/runtime/orchestrator.ts`, `apps/nanocore/src/runtime/types.ts`, and `apps/nanocore/src/runtime/worker-governance-turn-executor.ts` let turn startup pass optional scheduler-owned agent-session and binding refs into backend materialization, and `apps/nanocore/src/runtime/worker-governance-backend.ts` can pass that binding ref into OpenShell worker-control registration. Static placement still uses process-local random tokens until scheduler dispatch supplies lease lineage to turn execution.

The product-safe active-session projection resolves live worker-control state through the exact persisted Agent Environment Package snapshot. If that snapshot is not live or lineage is incomplete, the projection returns no control summary and command enqueue fails closed; it never borrows state from an older package or an agent-session-only lookup. Active-session terminal-command enqueue uses the same exact-lineage rule, so it targets the same package snapshot that the dashboard projects.

## Deferred / Future Work

- Define explicit maximum payload size and rejection diagnostics for any future non-envelope control route before exposing it.
- Add backend push command delivery only after the pull protocol is stable.
- Define `shutdown`, `collect-and-stop`, and `health-check` command schemas if they are still needed.
- Define the source and target snapshot schema, runtime and shim support negotiation, atomic lease and token rebinding, idempotency, rollback, and audit evidence before issuing any live supply refresh request.
- Define a workspace-change notice only if workspace synchronization cannot be represented by artifact notices, manifests, and data-plane collection.

## Testing Strategy

- Envelope validation tests.
- Token and lineage mismatch tests.
- Monotonic sequence tests with duplicates and gaps.
- Idempotency tests for retries.
- Direct live append plus transcript evidence collection tests.
- Oversized payload rejection tests.
- Command delivery tests for interrupt and terminal diagnostics.
- Import tests proving shim-suggested items are not canonical until NanoCore writes them.

## Risks & Mitigations

- Risk: Control becomes a backdoor shell. Mitigation: only allow named command families and require policy ids for diagnostics commands.
- Risk: Direct control failures lose work. Mitigation: stop or cancel the worker, preserve session-file evidence already written, and require a new bounded step rather than continuing ungoverned.
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
