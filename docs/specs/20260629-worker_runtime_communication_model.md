# Worker Runtime Communication Model

Status: Accepted
Implementation: Implemented

## Summary

OpenKit removes host execution as a real Worker Agent runtime and standardizes real Worker Agent execution on governed container runtimes.

NanoCore owns product state, policy, review, audit, verification, and canonical record import.

Every real Worker Agent runs inside a governed container runtime and communicates through one OpenKit worker-facing contract, regardless of whether the container placement is local or remote.

Runtime-native differences belong inside the worker container behind the OpenKit Worker Sidecar and runtime adapter packages.

NanoCore receives canonical OpenKit worker records, verifies lineage, schema, sequence, policy, digest, and workspace boundaries, and commits accepted records into the `Workspace -> Thread -> Turn -> Item[]` product model.

This document is the release-neutral overview for worker runtime communication. Concrete worker-control operations are owned by `docs/specs/20260703-worker_control_protocol.md`. Concrete capability-plane routes are owned by `docs/specs/20260703-worker_agent_capability.md`. Concrete workspace staging and synchronization are owned by `docs/specs/20260703-workspace_synchronization.md`.

## Owns

- The high-level worker runtime communication model for governed container workers.
- The separation between static supply, control, data, capability, inference, evidence, and audit planes.
- The worker-facing container contract that hides local versus remote placement from worker agents.
- The sidecar or shim responsibility boundary between worker-runtime adaptation and NanoCore-owned product verification.
- The rule that host execution is not a product Worker Agent runtime.
- The release-neutral packaging direction for worker protocol schemas, worker shim, sidecar logic, and runtime adapters.

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
- Require the OpenKit Worker Sidecar or an equivalent shim in every real worker container.
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
- Do not make the Worker Sidecar a second NanoCore, a product state owner, a review decision engine, or a generic shell daemon.
- Do not mix the user-facing `@openkit/mcp` channel with worker-side MCP capability supply.
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

`local-container` and `remote-container` may remain internal labels during implementation, but the public model should be runtime plus placement plus backend.

They must not become separate product semantics.

Host execution may exist only as deterministic test doubles, fixture executors, or in-process harnesses that cannot be selected through product configuration, MCP, Web UI, deployment docs, setup Skills, status summaries, or public capability flags.

## Worker-Facing Contract

Every real Worker Agent sees the same contract inside its container:

```text
/openkit/config/package.json
/openkit/session/events.jsonl
/openkit/session/items.jsonl
/openkit/session/artifacts.jsonl
/openkit/session/workspace-changes.json
https://control.local/v1/worker-control
https://capability.local/v1
https://inference.local/v1
declared workspace roots
declared output roots
```

The Worker Agent should not know whether the container is local or remote.

The Worker Agent should not know raw NanoCore host paths, raw remote gateway URLs, raw OpenShell gateway internals, raw backend upload/download handles, raw secrets, or private data-root paths.

The Worker Agent receives an Agent Environment Package snapshot, local files generated from that snapshot, sandbox-local endpoints, declared workspace roots, and declared output roots.

## Communication Planes

### Static Supply Plane

NanoCore resolves agent setup into an Agent Environment Package snapshot before launch.

The AEP snapshot carries lineage, selected runtime, workspace inputs, generated files, Skill refs, MCP server refs, provider refs, control endpoints, capability endpoints, LLM routes, policy summaries, and backend capability requirements.

The backend materializes the AEP snapshot into the container.

The Worker Sidecar converts AEP supply into runtime-native config files.

Examples include Codex config files, OpenCode config files, runtime-specific Skill paths, runtime-specific MCP config files, provider endpoint config, capability endpoint config, and transcript paths.

Dynamic supply changes create a new AEP snapshot.

NanoCore may deliver a safe-point supply refresh command only when the active sidecar and runtime adapter explicitly advertise refresh support.

When refresh support is absent or uncertain, NanoCore must finish or stop the current bounded step and launch the next step with the new AEP snapshot.

### Control Plane

The control plane uses `openkit-worker-control-v1`.

The worker-visible endpoint is `https://control.local/v1/worker-control`.

The control plane is for session lifecycle and small control messages only.

It must not become a generic capability RPC, arbitrary shell, file transfer channel, or product-state mutation API.

Current command families are:

- heartbeat
- artifact notice
- command polling
- approval result delivery
- interrupt delivery
- allowlisted terminal command delivery
- terminal result reporting

Required extensions are:

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

The worker-visible endpoint is `https://capability.local/v1`.

Capability families include worker-side MCP calls, Knowledge Store search, Knowledge Store read, context retrieval, external API calls, network proxy access, vault-mediated credential use, and future non-LLM tools.

NanoCore owns routing, policy checks, credential references, redaction, metering, audit summaries, and upstream error normalization.

Worker Agents must not access NanoCore internals, SQLite files, raw data roots, raw secrets, or arbitrary network sources to obtain these capabilities.

`https://inference.local/v1` remains the OpenAI-compatible LLM endpoint for Worker Agent runtimes that expect an OpenAI-style base URL.

`inference.local` is a specialized capability endpoint for LLM routing and must not be reused for control, knowledge, MCP, vault, or generic capability traffic.

Future implementations may route `inference.local` through the same server-side Agent Capability gateway projection as `capability.local`, but the worker-facing OpenAI-compatible endpoint may remain separate for runtime ergonomics.

### Evidence And Audit Plane

The evidence and audit plane records what was launched, what policy was applied, what the backend did, what the worker reported, what changed, and what a human reviewed.

The Worker Sidecar may produce normalized audit events and transcript records.

The backend may collect backend-native logs and transport evidence.

NanoCore verifies and stores product-safe summaries and evidence references.

Public App API, MCP, and Web UI surfaces expose OpenKit ids, summaries, digests, artifact ids, review ids, and next suggested actions rather than backend-private internals.

## OpenKit Worker Sidecar

Every real worker container must run the OpenKit Worker Sidecar or an equivalent shim.

The concrete container entrypoint should be `openkit-worker-shim`.

`openkit-worker-shim` composes sidecar-core with one runtime adapter, such as Codex or OpenCode.

The sidecar owns runtime-native adaptation inside the worker image.

NanoCore owns canonical verification outside the worker image.

The sidecar should:

- read the AEP snapshot and generated files
- materialize runtime-native Skill configuration
- materialize runtime-native MCP configuration
- materialize provider, model, control, capability, and inference endpoint configuration
- launch or supervise the Worker Agent runtime as a child process
- parse runtime-native stdout, JSONL, event streams, command logs, tool calls, and final messages
- convert runtime-native records into canonical OpenKit transcript and event records
- write `/openkit/session/events.jsonl`, `/openkit/session/items.jsonl`, and `/openkit/session/artifacts.jsonl`
- emit heartbeat and artifact notices through `control.local`
- append canonical events through `control.local` when live delivery is available
- write `/openkit/session/workspace-changes.json` when workspace changes are produced
- maintain sequence numbers and lineage on emitted records
- apply best-effort lightweight redaction before records leave the container
- keep a turn-end transcript fallback even when live control delivery fails

The sidecar must not:

- own Workspace, Thread, Turn, Item, Goal Mode, Action Center, Knowledge Store, Review, or Apply state
- make final authorization decisions
- bypass NanoCore policy checks
- install arbitrary Skills, MCP servers, tools, packages, or credentials
- read NanoCore private storage directly
- push, publish, tag, deploy, or trigger external side effects without a NanoCore-approved path
- become a generic interactive shell

Sidecar redaction is best effort.

NanoCore canonical verification and redaction remain the server-owned product boundary.

## Runtime Adapter Packaging

Runtime-native adapter logic should live outside NanoCore.

The preferred package structure is:

```text
packages/worker-protocol
  canonical worker-control, transcript, item, artifact, workspace-change, capability, sequence, lineage, and error schemas

packages/worker-sidecar-core
  lineage helpers, sequence helpers, control client, capability client, transcript writer, redaction, config materialization helpers

packages/worker-adapter-codex
  Codex CLI parsing, Codex config materialization, Codex MCP config materialization, Codex Skill materialization

packages/worker-adapter-opencode
  OpenCode parsing, OpenCode config materialization, OpenCode MCP config materialization, OpenCode Skill materialization

packages/worker-shim
  executable entrypoint composing sidecar-core with a selected runtime adapter
```

NanoCore may depend on canonical schemas from `packages/worker-protocol`.

NanoCore should not depend on runtime-native adapter packages.

Container images may depend on sidecar and adapter packages.

Adding a new Worker Agent should primarily require a new adapter package that maps native runtime behavior into canonical OpenKit records and maps AEP supply into native config files.

## Current Implementation Projection

The current implementation is the accepted V1 projection of this model:

- `packages/worker-protocol` exists and defines canonical worker lineage, schema version, worker event records, transcript records, workspace change manifests, capability call summaries, worker-control request and response envelopes, and worker error shapes.
- `packages/worker-shim` exists and provides `openkit-worker-sidecar`, `openkit-codex-shim`, a worker-control client, a capability client, transcript writing, worker workspace change manifests, and Codex-oriented runtime adaptation.
- Separate `packages/worker-sidecar-core`, `packages/worker-adapter-codex`, and `packages/worker-adapter-opencode` packages are deferred packaging extractions. Their V1 responsibilities currently live primarily in `packages/worker-shim`, which is the worker-side contract package for the first release.
- `apps/nanocore/src/runtime/agent-environment.ts` resolves OpenShell-backed AEP snapshots with `control.local`, `capability.local`, and `inference.local` endpoint projections.
- `apps/nanocore/src/runtime/worker-control-gateway.ts`, `worker-control-records.ts`, `worker-control-sequences.ts`, `worker-control-commands.ts`, `worker-control-rejected-evidence.ts`, and `worker-control-rebuild.ts` provide the durable V1 worker-control state, sequence, command, rejection-evidence, and restart-rebuild surfaces for registered AEP snapshots.
- `apps/nanocore/src/app.ts` exposes current worker-control routes for heartbeat, artifact notice, command polling, terminal results, supply refresh acknowledgement, knowledge proposal summary, and live canonical event append.
- `apps/nanocore/src/app.ts` exposes current worker capability routes for governed Knowledge search/read/proposal, artifact read, product-safe diagnostics, worker-side MCP list/list-tools/call, and OpenAI-compatible inference projection.
- `apps/nanocore/src/runtime/turn-executor-factory.ts` selects local or remote OpenShell placement from runtime environment configuration and rejects historical host selector shapes.
- The turn executor factory also rejects the historical `OPENKIT_REMOTE_CONTAINER_BACKEND` selector, keeping the public worker runtime model on `OPENKIT_WORKER_RUNTIME=container`, `OPENKIT_CONTAINER_PLACEMENT=local|remote`, and `OPENKIT_CONTAINER_BACKEND=openshell`.
- `apps/nanocore/src/runtime/worker-governance-backend.ts` validates OpenShell control endpoints, collects transcript and workspace-change data-plane artifacts, and imports product-safe records.
- `apps/nanocore/src/runtime/filesystem-workspace-sync.ts` and related storage code implement filesystem snapshot, staging, review, and apply records that are now owned by the workspace synchronization spec.

The accepted V1 communication model is implemented. Further package extraction, broader worker-side runtime adapters, generic future capability families, and richer Knowledge Store capability semantics remain future work over the same control, capability, data, inference, evidence, and audit planes.

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

The sidecar writes runtime-native Skill and MCP configuration from that resolved supply.

Worker-side MCP calls go through `capability.local` and NanoCore-owned policy, not through the user-facing `@openkit/mcp` server.

Dynamic supply changes create a new AEP snapshot and follow the safe-point refresh rules in the Static Supply Plane.

## Knowledge And Context

Knowledge and context access use the capability plane.

Initialization may inject selected knowledge-derived material as context package entries or product-visible context injection items.

Runtime retrieval should use governed capability calls such as knowledge search, knowledge read, context read, source read, and worker-side MCP calls.

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

NanoCore must preserve enough rejected-record diagnostics to debug worker and sidecar failures without importing invalid records into product history.

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

NanoCore may queue terminal commands only for narrowly allowlisted diagnostics or sidecar/runtime control operations.

The command allowlist belongs to NanoCore policy and the active AEP.

User-facing MCP, Web UI, and worker-side capability surfaces must not expose arbitrary command execution through this channel.

Terminal command results are evidence and diagnostics.

They are not a replacement for item history, artifacts, Action Center, or staged workspace review.

## Local Versus Remote Container Placement

Local and remote container placements share the same Worker-facing contract and product semantics.

They may differ only in backend transport and reachability.

Local placement may use a local OpenShell gateway, local relay upstream, local upload and download operations, and local diagnostic commands.

Remote placement may use a remote OpenShell gateway URL, explicit relay upstream reachable from the remote sandbox, remote upload and download operations, and remote diagnostic commands.

These differences must not leak into Worker records, public App API, MCP tools, Web UI, Goal Mode, Action Center, or review semantics.

## Failure And Recovery

Control channel failure should not automatically lose the turn.

When live control delivery fails, the sidecar should continue writing transcript files when possible.

At turn end, NanoCore should collect transcript files through backend transport and import validated records.

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

Public App API, MCP, Web UI, deployment docs, setup Skills, and status summaries should describe:

- Core mode: `local | server`
- Worker runtime: `container`
- Container placement: `local | remote`
- Container backend: `openshell` first

They should not advertise host execution as a supported Worker runtime.

The user-facing `@openkit/mcp` server remains a channel facade over NanoCore public APIs.

It may need new tools or resources to inspect worker runtime status, worker communication diagnostics, supply catalog summaries, capability call summaries, and staged review evidence.

It must not become worker-side MCP supply and must not expose backend-private sandbox control.

## Implementation Roadmap

Implementation should move through these release-neutral milestones:

1. Remove host Worker runtime from product selection and public surfaces.
2. Promote canonical worker schemas into `packages/worker-protocol`.
3. Extract sidecar-core and runtime adapter responsibilities from NanoCore and worker shim code.
4. Implement live canonical event append on the worker-control plane with transcript import deduplication.
5. Implement NanoCore-resolved Skill and MCP supply catalog materialization into container workers.
6. Implement worker capability plane routes for Knowledge Store search/read, knowledge proposals, and worker-side MCP calls.
7. Update `@openkit/mcp` and Skills so coordinator agents can inspect and drive the new runtime communication model through public NanoCore APIs.
8. Verify the full local and remote loop through public NanoCore APIs and MCP without relying on backend-private runtime state.

## Verification Expectations

The communication model is implemented only when:

- no real product runtime path uses host execution
- local and remote container placements generate equivalent AEP worker-facing control contracts
- local and remote container placements use the same sidecar protocol, transcript schema, event schema, capability schema, and workspace-change schema
- NanoCore validates canonical records without importing runtime-native adapters
- Worker Sidecar packages own runtime-native parsing and config materialization
- Skill and MCP supply comes from NanoCore-resolved catalog snapshots
- Knowledge Store and context access use governed capability or proposal flows
- terminal commands are narrowly allowlisted and cannot become generic shell access
- tests prove token, lineage, schema, sequence, idempotency, digest, workspace path, and policy validation
- e2e smoke proves local-container and remote-container can each run one bounded Goal Mode worker step and produce reviewable evidence
- MCP-driven dogfood loops prove the coordinator can inspect runtime status, run bounded steps, review evidence, and continue/refine/reject/accept without bypassing review gates

## Testing Strategy

Required local development machine verification:

- format and static checks for touched packages
- schema and contract tests for `packages/worker-protocol`, `packages/config-schema`, `packages/app-api-schemas`, and `packages/core-client`
- NanoCore unit and black-box tests for runtime selection, AEP generation, worker-control routes, event append, transcript import, workspace validation, capability calls, and Action Center review projection
- worker-sidecar-core and runtime adapter tests for config materialization, transcript writing, redaction, sequence handling, and runtime parser behavior
- `@openkit/mcp` tests, build, and smoke against a local NanoCore development server
- a real MCP-driven Goal Mode loop on the development machine using local container placement

Required remote placement verification:

- run NanoCore in server mode
- run the OpenShell remote gateway and remote container worker placement
- connect from a desktop agent app or MCP smoke harness through `@openkit/mcp`
- create or resume a real thread
- run one bounded Goal Mode step through remote container placement
- collect Action Center rows, artifacts, workspace review evidence, worker diagnostics, and capability summaries
- prove staged review rather than direct protected workspace mutation

Remote provider quota or real Codex subscription tests must remain opt-in and explicitly documented.

If an environment cannot run a check, the implementation evidence must record the exact reason and the narrowest rerun command.

## Risks And Mitigations

Risk: Removing host runtime slows local development.

Mitigation: invest in a fast local-container development profile and deterministic container tests.

Risk: Sidecar extraction becomes too large.

Mitigation: phase extraction through canonical schemas first, then sidecar-core, then runtime adapters.

Risk: `control.local` becomes a generic RPC.

Mitigation: keep capability traffic on `capability.local` and keep terminal commands allowlisted.

Risk: Worker-side MCP bypasses NanoCore policy.

Mitigation: require NanoCore-resolved MCP catalog snapshots and route worker-side calls through `capability.local`.

Risk: Remote recovery after NanoCore restart loses live token state.

Mitigation: persist product-safe materialization and collection state, collect transcript/data-plane fallback evidence, and require a new bounded step when live token recovery is unsafe.

## Decisions

- Host runtime is removed from product execution and public surfaces.
- Public runtime configuration should move to `OPENKIT_WORKER_RUNTIME=container`, `OPENKIT_CONTAINER_PLACEMENT=local|remote`, and `OPENKIT_CONTAINER_BACKEND=openshell`.
- `control.local` and `capability.local` are separate worker-facing endpoints.
- `inference.local` remains a specialized OpenAI-compatible LLM endpoint.
- `openkit-worker-shim` is the real container entrypoint that composes sidecar-core with a runtime adapter.
- Live canonical event append should be implemented before broad Skill, MCP, knowledge, and context capability work.
- Dynamic Skill and MCP updates create new AEP snapshots and refresh only at safe points when explicitly supported.
- Sidecar redaction is best effort; NanoCore redaction and verification remain authoritative.
- Terminal commands are narrowly allowlisted diagnostics or runtime-control operations, not a generic shell.

## Specialized Decision Index

This overview records the worker runtime communication direction. Detailed implementation decisions live in the narrower specs that own each contract:

- Worker-control live append route shape, envelope semantics, event sequence idempotency, stale/conflicting sequence handling, and response fields are owned by `docs/specs/20260703-worker_control_protocol.md`.
- Worker capability route projection, canonical `knowledge.*` target families, sandbox bearer lineage, `WorkerCapabilityCallSummary`, metering, and audit hooks are owned by `docs/specs/20260703-worker_agent_capability.md` and `docs/specs/20260702-knowledge_store_governance_rules.md`.
- Worker-side Skill and MCP catalog resolution, approved catalog ids, version or digest resolution, runtime-adapter compatibility, provider and vault references, and generated runtime config materialization are owned by `docs/specs/20260703-agent_manifest_aep_resolution.md` and `docs/specs/20260616-agent_environment_package.md`.
- Filesystem workspace staging, resolved-path containment, symlink escape rejection, staged review, apply, and recovery behavior are owned by `docs/specs/20260703-workspace_synchronization.md`.
- User-facing MCP coordinator diagnostics must use public NanoCore App API surfaces rather than runtime internals. Concrete AI interface tools and resources are owned by `docs/specs/20260617-openkit_ai_interface.md`.
- OpenShell network policy defaults, Codex binary allowlists, Git remote helper binary allowlists, and remote gateway transport details are owned by `docs/specs/20260627-remote_openshell_gateway.md`, `docs/specs/20260703-workspace_synchronization.md`, and NanoCore runtime implementation docs.
- Restart recovery is split between worker-control fallback, workspace synchronization recovery, evidence import, and bounded-step scheduling. Detailed rules are owned by `docs/specs/20260703-worker_control_protocol.md`, `docs/specs/20260703-workspace_synchronization.md`, `docs/specs/20260703-audit_usage_evidence_records.md`, and `docs/specs/20260703-runtime_scheduling_scale.md`.

## Related Documents

- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/core/communication.md`
- `docs/core/protocol.md`
- `docs/core/agent-capability.md`
- `docs/core/agent-supply.md`
- `docs/core/knowledge.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260617-openkit_ai_interface.md`
- `docs/specs/20260627-remote_openshell_gateway.md`
- `docs/specs/20260703-workspace_synchronization.md`
- `docs/specs/20260628-agent_setup_runtime_supply_contract.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260703-runtime_scheduling_scale.md`
