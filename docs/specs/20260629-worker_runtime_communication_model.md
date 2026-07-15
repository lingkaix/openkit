# Worker Runtime Communication Model

Status: Accepted
Implementation: Partial

## Summary

OpenKit removes host execution as a real Worker Agent runtime and standardizes real Worker Agent execution on governed container runtimes.

NanoCore owns product state, policy, review, audit, verification, and canonical record import.

Every real Worker Agent runs inside a governed container runtime and communicates through one OpenKit worker-facing contract, regardless of whether the container placement is local or remote.

Runtime-native differences belong inside the worker container behind the OpenKit worker shim and its runtime adapter.

NanoCore receives canonical OpenKit worker records, verifies lineage, schema, sequence, policy, digest, and workspace boundaries, and commits accepted records into the `Workspace -> Thread -> Turn -> Item[]` product model.

This document is the release-neutral overview for worker runtime communication. Concrete worker-control operations are owned by `docs/specs/20260703-worker_control_protocol.md`. Concrete capability-plane routes are owned by `docs/specs/20260703-worker_agent_capability.md`. Concrete workspace staging and synchronization are owned by `docs/specs/20260703-workspace_synchronization.md`.

## Owns

- The high-level worker runtime communication model for governed container workers.
- The separation between static supply, control, data, capability, inference, evidence, and audit planes.
- The worker-facing container contract that hides local versus remote placement from worker agents.
- The worker-shim responsibility boundary between worker-runtime adaptation and NanoCore-owned product verification.
- The rule that host execution is not a product Worker Agent runtime.
- The release-neutral packaging direction for worker protocol schemas, the worker shim, and runtime adapters.

## Does Not Own

- Concrete worker-control operation schemas, route semantics, and persistence rules.
- Concrete worker capability route schemas, metering, and gateway records.
- AEP schema fields or manifest resolution.
- Runtime scheduling, warm pools, queueing, capacity, or placement decisions.
- Workspace synchronization record schemas, staging review, and apply semantics.
- Permission policy semantics, vault storage, audit storage, usage storage, or Knowledge Store governance.
- Release plans, environment-specific rollout steps, or change-record lifecycle tracking.

## Core References

- `docs/core/runtime-model.md`
- `docs/core/communication.md`
- `docs/core/agent-session.md`
- `docs/core/agent-capability.md`
- `docs/core/agent-supply.md`
- `docs/core/sandbox.md`
- `docs/core/storage.md`

## Goals

- Remove host execution as a product runtime, deployment mode, and communication path.
- Keep deterministic test fixtures available without treating them as real Worker runtimes.
- Define one Worker-facing communication contract for local and remote governed containers.
- Keep local and remote placement differences inside backend transport adapters.
- Require the OpenKit worker shim in every real worker container.
- Move runtime-native output parsing, config materialization, Skill placement, MCP placement, and lightweight transcript normalization into worker-side packages.
- Keep NanoCore focused on policy resolution, Agent Environment Package snapshot creation, canonical record verification, durable state, Action Center, evidence, and review gates.
- Preserve backend portability for OpenShell first and later Docker, VM, Kubernetes, managed sandbox, or custom worker runtimes.
- Prepare the design for controlled Skill, MCP, Knowledge Store, context, and tool supply without allowing Worker Agents to install arbitrary resources.
- Keep all worker-produced repository changes behind NanoCore-owned staged review and apply gates.

## Non-goals

- Do not keep a host fallback for real Worker execution.
- Do not expose host execution through product config, MCP, Web UI, deployment docs, setup Skills, capability flags, or status summaries.
- Do not make OpenShell policy YAML, sandbox ids, gateway internals, raw environment variables, process handles, or provider secrets public OpenKit protocol.
- Do not let a Worker Agent install Skills, MCP servers, tools, packages, or credentials from arbitrary sources.
- Do not let a Worker Agent write long-term knowledge, notes, or Knowledge Store records directly.
- Do not make the worker shim a second NanoCore, a product state owner, a review decision engine, or a generic shell daemon.
- Do not mix the end-user Agent Skill Interface with worker-side MCP capability supply.
- Do not allow sandbox workers to push, publish, tag, deploy, or mutate protected branches without NanoCore-owned review and apply gates.
- Do not keep historical host runtime configuration shapes as supported product behavior.

## Runtime Model

OpenKit separates Core mode from Worker runtime placement.

Core mode remains:

```text
local | server
```

The real Worker runtime model becomes:

```text
Worker runtime: container
Container placement: local | remote
Container backend: openshell first, more backends later
```

The implementation should move toward explicit configuration names:

```text
OPENKIT_WORKER_RUNTIME=container
OPENKIT_CONTAINER_PLACEMENT=local|remote
OPENKIT_CONTAINER_BACKEND=openshell
```

Internal and public runtime records use runtime plus placement plus backend. Historical compound labels are not aliases or supported compatibility shapes.

Host execution may exist only as deterministic test doubles, fixture executors, or in-process harnesses that cannot be selected through product configuration, MCP, Web UI, deployment docs, setup Skills, status summaries, or public capability flags.

## Worker-Facing Contract

Every real Worker Agent sees the same contract inside its container:

```text
/openkit/config/package.json
/openkit/session/events.jsonl
/openkit/session/items.jsonl
/openkit/session/artifacts.jsonl
/openkit/session/workspace-changes.json
<AEP-resolved NanoCore /api/worker-control base URL>
<AEP-resolved OpenAI-compatible LLM base URL>
declared workspace roots
declared output roots
```

The Worker Agent should not know whether the container is local or remote.

The Worker Agent should not know raw NanoCore host paths, raw remote gateway URLs, raw OpenShell gateway internals, raw backend upload/download handles, raw secrets, or private data-root paths.

The Worker Agent receives an Agent Environment Package snapshot, local files generated from that snapshot, exact worker-reachable endpoints, declared workspace roots, and declared output roots. Current AEPs declare the capability plane disabled with no routes; `capability.local` remains an accepted future projection, not a current endpoint.

## Communication Planes

### Static Supply Plane

NanoCore resolves agent setup into an Agent Environment Package snapshot before launch.

The AEP snapshot carries lineage, selected runtime, workspace inputs, generated files, Skill refs, MCP server refs, provider refs, control endpoints, capability endpoints, LLM routes, policy summaries, and backend capability requirements.

The backend materializes the AEP snapshot into the container.

The worker shim converts AEP supply into runtime-native config files.

Examples include Codex config files, OpenCode config files, runtime-specific Skill paths, runtime-specific MCP config files, provider endpoint config, capability endpoint config, and transcript paths.

Dynamic supply changes create a new AEP snapshot.

NanoCore may deliver a safe-point supply refresh command only when the active shim and runtime adapter explicitly advertise refresh support.

When refresh support is absent or uncertain, NanoCore must finish or stop the current bounded step and launch the next step with the new AEP snapshot.

### Control Plane

The control plane uses `openkit-worker-control-v1`.

The worker-visible endpoint is the AEP-resolved HTTP(S) NanoCore base URL whose path is `/api/worker-control`.

The control plane is for session lifecycle and small control messages only.

It must not become a generic capability RPC, arbitrary shell, file transfer channel, or product-state mutation API.

Current worker-control families are:

- heartbeat
- artifact notice
- command polling
- interrupt delivery
- allowlisted terminal command delivery
- terminal result reporting

Current worker-to-NanoCore record families also include:

- canonical event append
- final status reporting
- supply refresh notice
- capability call notification summaries
- knowledge proposal notification summaries

Every control request must carry sandbox session token authentication and lineage.

Lineage includes workspace id, thread id, turn id, agent session id, package snapshot id, and request id when available.

Every ordered worker-emitted record must carry a monotonic worker sequence number.

NanoCore must reject token, lineage, sequence, idempotency, policy, digest, workspace path, and schema violations fail-closed with redacted diagnostics.

### Data Plane

The data plane moves large payloads through backend transport rather than the control channel.

Examples include workspace snapshots, Git checkouts, tar bundles, patches, commit bundles, changed-file manifests, generated artifacts, raw or summarized logs, and backend evidence.

For OpenShell, this can use sandbox upload, sandbox download, sandbox exec, retained session directories, and future OpenShell file primitives.

For future backends, this can use bind mounts, `docker cp`, tar streams, SSH, rsync, object storage, provider file APIs, or managed sandbox file APIs.

NanoCore must normalize collected data into OpenKit records such as `WorkspaceInputSnapshot`, `WorkspaceMaterializationRecord`, `WorkspaceChangeSet`, `StagedWorkspaceReview`, `WorkspaceApplyResult`, `Artifact`, `Evidence`, and Action Center rows.

The control plane may announce that data is ready, but it must not carry full patches, bundles, artifact files, or raw logs except within strict product metadata limits.

### Capability Plane

The capability plane gives Worker Agents governed access to privileged services.

The accepted target endpoint is `https://capability.local/v1`, but the current AEP projection is exactly `capabilities.mode: disabled` with `routes: []`.

Planned capability families include worker-side MCP calls, Knowledge Store search, Knowledge Store read, context retrieval, external API calls, network proxy access, vault-mediated credential use, and future non-LLM tools.

NanoCore owns routing, policy checks, credential references, redaction, metering, audit summaries, and upstream error normalization.

Worker Agents must not access NanoCore internals, SQLite files, raw data roots, raw secrets, or arbitrary network sources to obtain these capabilities. Until the plane is implemented, workers have no callable capability route.

Every Worker Agent runtime that expects an OpenAI-style base URL receives one from its AEP. Backend-local inference may use `https://inference.local/v1`; attributed worker inference receives the exact authenticated NanoCore worker-inference base URL.

The AEP-resolved LLM route is specialized for inference and must not be reused for control, knowledge, MCP, vault, or generic capability traffic.

When implemented, the capability plane may share server-side policy, ledger, and provider dispatch owners with authenticated worker inference while retaining a separate worker-facing wire contract.

### Evidence And Audit Plane

The evidence and audit plane records what was launched, what policy was applied, what the backend did, what the worker reported, what changed, and what a human reviewed.

The worker shim may produce normalized audit events and transcript records.

The backend may collect backend-native logs and transport evidence.

NanoCore verifies and stores product-safe summaries and evidence references.

Public App API, end-user Agent Skill Interface, and Web UI surfaces expose OpenKit ids, summaries, digests, artifact ids, review ids, and next suggested actions rather than backend-private internals.

## OpenKit Worker Shim

Every real worker container runs an OpenKit worker shim. The current concrete entrypoint is `openkit-codex-shim`; the removed `openkit-worker-sidecar` binary is not part of the architecture.

The shim owns runtime-native adaptation inside the worker image. NanoCore owns canonical verification outside the worker image.

The shim should:

- read the AEP snapshot and generated files
- materialize runtime-native Skill configuration
- materialize approved runtime-native Skill and MCP configuration as static supply
- materialize provider, model, direct control, and inference endpoint configuration
- launch or supervise the Worker Agent runtime as a child process
- parse runtime-native stdout, JSONL, event streams, command logs, tool calls, and final messages
- convert runtime-native records into canonical OpenKit transcript and event records
- write `/openkit/session/events.jsonl`, `/openkit/session/items.jsonl`, and `/openkit/session/artifacts.jsonl`
- emit heartbeat and artifact notices through direct NanoCore worker control
- append canonical events through direct NanoCore worker control
- write `/openkit/session/workspace-changes.json` when workspace changes are produced
- maintain sequence numbers and lineage on emitted records
- apply best-effort lightweight redaction before records leave the container
- stop or cancel the worker when required direct control fails while retaining transcript evidence already written

The shim must not:

- own Workspace, Thread, Turn, Item, Goal Mode, Action Center, Knowledge Store, Review, or Apply state
- make final authorization decisions
- bypass NanoCore policy checks
- install arbitrary Skills, MCP servers, tools, packages, or credentials
- read NanoCore private storage directly
- push, publish, tag, deploy, or trigger external side effects without a NanoCore-approved path
- become a generic interactive shell

Shim redaction is best effort.

NanoCore canonical verification and redaction remain the server-owned product boundary.

## Runtime Adapter Packaging

Runtime-native adapter logic lives outside NanoCore. The current package structure is:

```text
packages/worker-protocol
  canonical worker-control, transcript, item, artifact, workspace-change, capability, sequence, lineage, and error schemas

packages/worker-shim
  direct worker-control client, transcript writer, redaction, config materialization, and Codex runtime adaptation
```

NanoCore may depend on canonical schemas from `packages/worker-protocol`.

NanoCore should not depend on runtime-native adapter packages.

Container images may depend on the worker protocol and worker shim packages.

Adding a new Worker Agent should extend or split the runtime adapter only when a concrete second runtime requires a separate ownership boundary.

## Current Implementation Projection

The current implementation is a partial projection of this model:

- `packages/worker-protocol` exists and defines canonical worker lineage, schema version, worker event records, transcript records, workspace change manifests, capability call summaries, worker-control request and response envelopes, and worker error shapes.
- `packages/worker-shim` provides `openkit-codex-shim`, a direct NanoCore worker-control client, transcript writing, worker workspace change manifests, and Codex-oriented runtime adaptation. It has no worker capability client and no sidecar binary.
- `apps/nanocore/src/runtime/agent-environment.ts` resolves OpenShell-backed AEP snapshots with required `direct-nanocore` control and exact `worker-control` backend capability requirements. Current packages emit a disabled capability plane with no routes.
- `apps/nanocore/src/runtime/worker-control-gateway.ts`, `worker-control-records.ts`, `worker-control-sequences.ts`, `worker-control-commands.ts`, `worker-control-rejected-evidence.ts`, and `worker-control-rebuild.ts` provide the durable V1 worker-control state, sequence, command, rejection-evidence, and restart-rebuild surfaces for registered AEP snapshots.
- `apps/nanocore/src/app.ts` exposes current worker-control routes for heartbeat, artifact notice, command polling and acknowledgement, terminal results, event append, final status, supply-refresh acknowledgement, capability-call summary, and knowledge-proposal summary.
- NanoCore exposes no `/api/worker-capabilities/*` routes and no worker MCP gateway. `WorkerCapabilityCallSummary` remains a transcript/import schema and does not prove a callable capability route.
- `apps/nanocore/src/runtime/turn-executor-factory.ts` selects local or remote disposable OpenShell Cell placement and rejects historical host selector shapes.
- Remote placement binds one validated SSH lifecycle target to an operator-managed loopback HTTP Gateway origin and an explicit credential-free HTTP(S) `/api/worker-control` URL reachable from the sandbox.
- The public worker runtime model has only `OPENKIT_WORKER_RUNTIME=container`, `OPENKIT_CONTAINER_PLACEMENT=local|remote`, and `OPENKIT_CONTAINER_BACKEND=openshell`; historical host selectors are absent rather than recognized as compatibility inputs.
- `apps/nanocore/src/runtime/worker-governance-backend.ts` validates OpenShell control endpoints, collects transcript and workspace-change data-plane artifacts, and imports product-safe records.
- `apps/nanocore/src/runtime/filesystem-workspace-sync.ts` and related storage code implement filesystem snapshot, staging, review, and apply records that are now owned by the workspace synchronization spec.

Direct control, data collection, generic inference, evidence, and audit foundations are implemented. The worker capability plane and worker MCP gateway are not implemented and remain accepted future contracts. The trusted worker-inference and runtime-provenance extension remains governed by `docs/specs/20260711-worker_runtime_subagent_provenance.md`, including its separate production proof requirement.

## Skill And MCP Supply

Skills and MCP servers are supply controlled by NanoCore.

Worker Agents must not discover or install them from arbitrary sources at runtime.

NanoCore resolves a workspace-scoped catalog entry into an AEP supply snapshot.

The minimum catalog record should include:

- stable id
- kind
- version
- digest
- source reference
- materialization kind
- allowed runtime adapters
- allowed workspace scopes
- allowed tools or prompts
- network policy hints
- secret reference ids
- review status
- created by
- updated at

The AEP snapshot should include stable ids, versions, digests, allowed runtime families, allowed tools, policy annotations, materialization hints, and secret references without secret values.

The backend transfers the resolved supply into the container.

The shim writes runtime-native Skill and MCP configuration from that resolved supply.

Static MCP supply does not grant a callable tool route. Future worker-side MCP calls will use the accepted `capability.local` contract and NanoCore-owned policy, not the end-user Skill's bundled CLI.

Dynamic supply changes create a new AEP snapshot and follow the safe-point refresh rules in the Static Supply Plane.

## Knowledge And Context

Runtime Knowledge and context access will use the capability plane after that plane is implemented.

Initialization may inject selected knowledge-derived material as context package entries or product-visible context injection items.

Runtime retrieval should use future governed capability calls such as knowledge search, knowledge read, context read, source read, and worker-side MCP calls.

Each retrieval call should produce an auditable capability call summary, and product-visible retrieval should be referenced by an item when it affects the worker-visible conversation or result.

Worker writes to long-term knowledge must be proposals.

NanoCore projects proposals into Action Center review rows and commits only accepted or edited records.

Worker Agents must not write Knowledge Store, note, or knowledge-base storage directly.

## Canonical Event Append

Live event append is required before broad worker-side Skill, MCP, knowledge, and context capabilities are considered complete.

The first live append surface should accept canonical worker records for:

- `worker.ready`
- `worker.heartbeat`
- `item.created`
- `item.delta`
- `item.completed`
- `artifact.created`
- `artifact.updated`
- `turn.completed`
- `turn.failed`

NanoCore assigns or validates final product ids according to server policy.

Worker-provided ids are candidate ids unless the schema explicitly marks them as stable package-scoped ids.

NanoCore must preserve enough rejected-record diagnostics to debug worker and shim failures without importing invalid records into product history.

## Sequence, Idempotency, And Replay

Every worker-emitted control record must include lineage and sequence.

Sequence numbers are monotonic within one package snapshot and channel.

NanoCore should reject stale sequence numbers, deduplicate exact retries, and return idempotency conflicts when a repeated sequence or request id carries different semantic content.

Control polling should support a cursor or delivered-sequence model so a worker can recover from transient network failures without losing pending commands.

Live append must work with turn-end transcript import.

If a live record was already accepted, transcript import must deduplicate it instead of creating duplicate items or artifacts.

## Workspace Validation

Worker-produced workspace changes must be validated before staging.

NanoCore must validate:

- changed paths are relative to declared writable roots
- path traversal is rejected
- symlink escape is rejected
- undeclared output roots are rejected
- base commit or snapshot digest matches the materialization record
- patch or bundle digest matches the collected payload
- binary, delete, permission, and large-file changes are summarized
- generated artifact paths are declared or explicitly reviewed
- protected branch mutation is not attempted from the worker runtime

Invalid change records should create diagnostics and fail or block the turn according to AEP policy.

They must not be silently applied.

## Terminal Commands

`terminal-command` is not a generic shell channel.

NanoCore may queue terminal commands only for narrowly allowlisted diagnostics or shim/runtime control operations.

The command allowlist belongs to NanoCore policy and the active AEP.

User-facing MCP, Web UI, and worker-side capability surfaces must not expose arbitrary command execution through this channel.

Terminal command results are evidence and diagnostics.

They are not a replacement for item history, artifacts, Action Center, or staged workspace review.

## Local Versus Remote Container Placement

Local and remote container placements share the same Worker-facing contract and product semantics.

They may differ only in backend transport and reachability.

Local placement uses the stock Gateway inside the co-located disposable Cell, a worker-reachable direct NanoCore endpoint, local upload and download operations, and local diagnostic commands.

Remote placement uses the same stock OpenShell `0.0.80` backend inside a remote disposable Cell. NanoCore invokes only the fixed Cell helper actions through non-interactive SSH, reaches the Cell's loopback Gateway through a separate operator-managed local forward, and supplies the exact credential-free HTTP(S) `/api/worker-control` URL that the sandbox can reach.

A naked or shared Gateway, insecure Gateway mode, custom OpenShell binary, resource-delete cleanup, fork, patch, compatibility selector, or host fallback is not a remote placement.

These differences must not leak into Worker records, public App API, end-user CLI operations, Web UI, Goal Mode, Action Center, or review semantics.

## Failure And Recovery

Required direct control failure stops or cancels the worker; it does not activate another control mode. NanoCore should still collect transcript files already written through backend transport and import validated records as evidence.

If transcript files are missing and required by the AEP, the turn should fail with a redacted diagnostic.

If token validation, lineage validation, sequence validation, policy validation, workspace path validation, digest validation, or schema validation fails, NanoCore must reject the record and preserve a diagnostic.

Remote backend unavailability must not fall back to host execution.

NanoCore may retry backend transport when the operation is idempotent and safe.

NanoCore should persist enough state to diagnose or recover after restart, including:

- AEP snapshot id and redacted snapshot summary
- materialization record id
- backend session label or product-safe sandbox label
- control registration metadata without raw token values
- workspace input digest
- expected transcript paths
- expected workspace-change manifest path
- change-set collection state
- staged review state

Sandbox tokens do not need to be persisted as reusable secret material.

If a restart loses an active sandbox token, NanoCore should recover by collecting available backend data, marking the session blocked or failed with evidence, and requiring a new bounded step.

## Public Surfaces

Public App API, the end-user Agent Skill Interface, Web UI, deployment docs, and status summaries should describe:

- Core mode: `local | server`
- Worker runtime: `container`
- Container placement: `local | remote`
- Container backend: `openshell` first

They should not advertise host execution as a supported Worker runtime.

The end-user `openkit` Skill's bundled CLI is the accepted channel facade over NanoCore public APIs; the currently implemented `@openkit/mcp` facade is removal-only until replacement parity is complete.

The transport-neutral operation catalog may need operations to inspect worker runtime status, worker communication diagnostics, supply catalog summaries, capability call summaries, and staged review evidence.

It must not become worker-side MCP supply and must not expose backend-private sandbox control.

## Implementation Roadmap

Implementation should move through these release-neutral milestones:

1. Remove host Worker runtime from product selection and public surfaces.
2. Promote canonical worker schemas into `packages/worker-protocol`.
3. Keep direct worker control and Codex adaptation cohesive in `packages/worker-shim`; split an adapter only when a concrete second runtime needs it.
4. Complete live canonical event append and transcript import deduplication on direct worker control.
5. Complete NanoCore-resolved Skill and MCP supply catalog materialization into container workers.
6. Rebuild the worker capability plane, thin shim client, Knowledge Store operations, and worker MCP gateway from their accepted contracts without adding another control path.
7. Update the unified `openkit` Skill, bundled CLI, and operation catalog so coordinator agents can inspect and drive the new runtime communication model through public NanoCore APIs.
8. Verify the full local and remote loop through public NanoCore APIs and the Agent Skill Interface without relying on backend-private runtime state.

## Verification Expectations

The communication model is implemented only when:

- no real product runtime path uses host execution
- local and remote container placements generate equivalent AEP worker-facing control contracts
- local and remote container placements use the same direct worker-control protocol, transcript schema, event schema, disabled capability declaration, and workspace-change schema
- NanoCore validates canonical records without importing runtime-native adapters
- Worker shim code owns runtime-native parsing and config materialization
- Skill and MCP supply comes from NanoCore-resolved catalog snapshots
- the future worker capability plane passes governed Knowledge Store, context, MCP, and proposal-flow acceptance before it is advertised
- terminal commands are narrowly allowlisted and cannot become generic shell access
- tests prove token, lineage, schema, sequence, idempotency, digest, workspace path, and policy validation
- e2e smoke proves the local disposable Cell can run one bounded Goal Mode worker step, produce reviewable evidence, recycle the complete runtime, and return a fresh stable-empty Cell
- remote backend e2e proves fixed SSH prepare and recycle, stock Gateway preflight, sandbox materialization, data transport, and a fresh empty replacement Cell
- real Codex provenance acceptance proves the complete attributed remote worker path before this spec may become `Implemented`
- Agent-Skill-driven dogfood loops prove the coordinator can inspect runtime status, run bounded steps, review evidence, and continue/refine/reject/accept without bypassing review gates

## Testing Strategy

Required local development machine verification:

- format and static checks for touched packages
- schema and contract tests for `packages/worker-protocol`, `packages/config-schema`, `packages/app-api-schemas`, and `packages/core-client`
- NanoCore unit and black-box tests for runtime selection, AEP generation, direct worker-control routes, event append, transcript import, workspace validation, and Action Center review projection
- worker-shim tests for direct control, config materialization, transcript writing, redaction, sequence handling, and runtime parser behavior
- future capability-plane tests for route authentication, Knowledge operations, MCP calls, usage, audit, and fail-closed disabled projection before those routes are advertised
- bundled CLI tests, build, and smoke against a local NanoCore development server
- a real Agent-Skill-driven Goal Mode loop on the development machine using local container placement

Required remote placement verification:

- run NanoCore in server mode
- run the stock OpenShell `0.0.80` remote disposable Cell through the fixed SSH lifecycle target and operator-managed loopback Gateway forward
- provide one explicit credential-free HTTP(S) `/api/worker-control` URL that the remote sandbox can reach
- connect from a Skill-capable agent app through the bundled `openkit` CLI
- create or resume a real thread
- run one bounded Goal Mode step through remote container placement
- collect Action Center rows, artifacts, workspace review evidence, worker diagnostics, and capability summaries
- prove staged review rather than direct protected workspace mutation

Remote provider quota or real Codex subscription tests must remain opt-in and explicitly documented.

If an environment cannot run a check, the implementation evidence must record the exact reason and the narrowest rerun command.

## Risks And Mitigations

Risk: Removing host runtime slows local development.

Mitigation: invest in a fast local-container development profile and deterministic container tests.

Risk: Direct worker control becomes a generic RPC.

Mitigation: keep the direct route limited to the worker-control protocol, keep terminal commands allowlisted, and implement capabilities on their separate future plane.

Risk: Worker-side MCP bypasses NanoCore policy.

Mitigation: advertise no worker capability route until NanoCore-resolved MCP catalog snapshots, gateway policy, and the thin `capability.local` client pass acceptance.

Risk: Remote recovery after NanoCore restart loses live token state.

Mitigation: persist product-safe materialization and collection state, collect transcript/data-plane evidence, and require a new bounded step when live token recovery is unsafe.

## Decisions

- Host runtime is removed from product execution and public surfaces.
- Public runtime configuration should move to `OPENKIT_WORKER_RUNTIME=container`, `OPENKIT_CONTAINER_PLACEMENT=local|remote`, and `OPENKIT_CONTAINER_BACKEND=openshell`.
- Direct NanoCore `/api/worker-control` is the only worker-control endpoint. The accepted future `capability.local` projection is a separate plane and must not carry control traffic.
- The AEP resolves one specialized OpenAI-compatible LLM endpoint: backend-local `inference.local` or the authenticated NanoCore worker-inference base URL when complete attribution is required.
- `openkit-codex-shim` is the current real container entrypoint and owns the cohesive Codex adapter path.
- Live canonical event append should be implemented before broad Skill, MCP, knowledge, and context capability work.
- Dynamic Skill and MCP updates create new AEP snapshots and refresh only at safe points when explicitly supported.
- Shim redaction is best effort; NanoCore redaction and verification remain authoritative.
- Terminal commands are narrowly allowlisted diagnostics or runtime-control operations, not a generic shell.

## Specialized Decision Index

This overview records the worker runtime communication direction. Detailed implementation decisions live in the narrower specs that own each contract:

- Worker-control live append route shape, envelope semantics, event sequence idempotency, stale/conflicting sequence handling, and response fields are owned by `docs/specs/20260703-worker_control_protocol.md`.
- Runtime-internal sub-agent raw capture, parent-child provenance, trusted worker-inference identity, and runtime cache lineage are owned by `docs/specs/20260711-worker_runtime_subagent_provenance.md`.
- Worker capability route projection, canonical `knowledge.*` target families, sandbox bearer lineage, `WorkerCapabilityCallSummary`, metering, and audit hooks are owned by `docs/specs/20260703-worker_agent_capability.md` and `docs/specs/20260702-knowledge_store_governance_rules.md`.
- Worker-side Skill and MCP catalog resolution, approved catalog ids, version or digest resolution, runtime-adapter compatibility, provider and vault references, and generated runtime config materialization are owned by `docs/specs/20260703-agent_manifest_aep_resolution.md` and `docs/specs/20260616-agent_environment_package.md`.
- Filesystem workspace staging, resolved-path containment, symlink escape rejection, staged review, apply, and recovery behavior are owned by `docs/specs/20260703-workspace_synchronization.md`.
- End-user coordinator diagnostics must use public NanoCore App API surfaces rather than runtime internals. Concrete Skill guidance and CLI operations are owned by `docs/specs/20260713-openkit_agent_skill_interface.md`.
- OpenShell network policy defaults, Codex binary allowlists, Git remote helper binary allowlists, and disposable Cell lifecycle details are owned by `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`, `docs/specs/20260703-workspace_synchronization.md`, and NanoCore runtime implementation docs.
- Restart recovery is split between direct worker-control recovery, workspace synchronization recovery, evidence import, and bounded-step scheduling. Detailed rules are owned by `docs/specs/20260703-worker_control_protocol.md`, `docs/specs/20260703-workspace_synchronization.md`, `docs/specs/20260703-audit_usage_evidence_records.md`, and `docs/specs/20260703-runtime_scheduling_scale.md`.

## Related Documents

- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/core/communication.md`
- `docs/core/protocol.md`
- `docs/core/agent-capability.md`
- `docs/core/agent-supply.md`
- `docs/core/knowledge.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260713-openkit_agent_skill_interface.md`
- `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
- `docs/specs/20260703-workspace_synchronization.md`
- `docs/specs/20260628-agent_setup_runtime_supply_contract.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
- `docs/specs/20260703-runtime_scheduling_scale.md`
