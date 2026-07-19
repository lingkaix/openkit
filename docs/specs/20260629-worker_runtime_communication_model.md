# Worker Runtime Communication Model

Status: Accepted
Implementation: Partial

## Summary

OpenKit removes host execution as a real Worker Agent runtime and standardizes real Worker Agent execution on governed container runtimes.

NanoCore owns product state, policy, review, audit, verification, and validated record import.

Every real Worker Agent runs inside a governed container runtime and communicates through one OpenKit worker-facing contract, regardless of whether the container placement is local or remote.

Runtime-native differences belong inside the worker container behind the OpenKit worker shim and its runtime adapter.

NanoCore receives schema-conformant candidate OpenKit worker records, verifies lineage, schema, sequence, policy, digest, and workspace boundaries, and commits accepted records into the `Workspace -> Thread -> Turn -> Item[]` product model.

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
- Preserve an already launched worker through a bounded retryable direct-control interruption without creating an alternate control path, replacement worker, or replacement session.
- Move runtime-native command construction, output parsing, isolated state-root selection, and lightweight transcript normalization into worker-side packages.
- Keep NanoCore focused on policy resolution, Agent Environment Package snapshot creation, canonical record verification, durable state, Action Center, evidence, and review gates.
- Preserve backend portability for OpenShell first and later Docker, VM, Kubernetes, managed sandbox, or custom worker runtimes.
- Prepare the design for controlled Skill, MCP, Knowledge Store, context, and tool supply without allowing Worker Agents to install arbitrary resources.
- Keep all worker-produced repository changes behind NanoCore-owned staged review and apply gates.
- Prove a stable runtime extension boundary with Codex, OpenCode, and Pi so a fourth Worker Agent adds only one authored `AgentManifest`, one worker-side adapter module plus its static registry entry, and one governed image definition plus its entry in the existing image catalog.

## Primary Extensibility Criterion

> The real outcome is not three adapters. The fourth Worker Agent must require only one authored `AgentManifest`, one worker-side adapter module plus its static registry entry, and one governed image definition plus its entry in the existing image catalog; NanoCore's product and governance core must not change.

Runtime ids are opaque to NanoCore. A new runtime must not require a NanoCore enum member, runtime-name branch, command builder, native output parser, provider special case, image-selection branch, canonical schema variant, or governance rule.

The fourth-runtime test is architectural acceptance, not a later optimization. If a new adapter requires a NanoCore product or governance edit, this boundary has failed even when the worker can execute successfully.

The registry and image-catalog entries are static bookkeeping in existing owners. Dynamic adapter discovery, package loading, or a plugin framework is neither required nor permitted by this criterion.

## Non-goals

- Do not keep a host fallback for real Worker execution.
- Do not expose host execution through product config, the end-user Agent Skill Interface, Web UI, deployment docs, capability flags, or status summaries.
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

These are server, scheduler, and backend topology fields, not AgentManifest fields. An AgentManifest owns runtime supply but no `mode`, `deployment`, or `transport`; remote OpenShell Gateway origin, SSH lifecycle target, and placement remain backend configuration and records.

Host execution may exist only as deterministic test doubles, fixture executors, or in-process harnesses that cannot be selected through product configuration, the end-user Agent Skill Interface, Web UI, deployment docs, status summaries, or public capability flags.

## Worker-Facing Contract

Every real Worker Agent sees the same contract inside its container:

```text
/openkit/config/package.json
/openkit/session/events.jsonl
/openkit/session/items.jsonl
/openkit/session/artifacts.jsonl
/openkit/session/workspace-changes.json
<AEP-resolved NanoCore /api/worker-control base URL>
<one AEP-resolved LLM route and its adapter-supported projection>
declared workspace roots
declared output roots
```

The Worker Agent should not know whether the container is local or remote.

The Worker Agent should not know raw NanoCore host paths, raw remote gateway URLs, raw OpenShell gateway internals, raw backend upload/download handles, raw secrets, or private data-root paths.

The Worker Agent receives an Agent Environment Package snapshot, local files generated from that snapshot, exact worker-reachable endpoints, declared workspace roots, and declared output roots. Current AEPs declare the capability plane disabled with no routes; `capability.local` remains an accepted future projection, not a current endpoint.

## Communication Planes

### Static Supply Plane

NanoCore resolves agent setup into an Agent Environment Package snapshot before launch.

The AEP snapshot carries lineage, selected runtime, workspace inputs, generated files, Skill refs, inert MCP supply refs, provider refs, control endpoints, the explicit disabled capability declaration, LLM routes, policy summaries, and backend capability requirements. A current Codex, OpenCode, or Pi launch must contain exactly one already resolved LLM route; zero or multiple routes fail before child launch, and neither the shim nor the adapter selects or falls back among routes.

The backend materializes the AEP snapshot into the container.

The selected worker adapter converts resolved AEP inputs into runtime-native argv and safe environment bindings. There is no universal provider-route projection: each adapter must prove that its pinned runtime can represent the exact route, provider/model selection, credential environment name, and wire protocol. An unsupported runtime-route pairing fails closed before child launch rather than being normalized, inferred, or replaced.

The current adapter contract has no adapter-returned config-artifact field. The shared harness materializes only runtime-neutral AEP files, supplies one fresh session state root, and rejects any attempt to introduce adapter-authored files through the launch plan. Codex, OpenCode, and Pi express current native setup only through adapter-owned argv and safe environment bindings; a future runtime that requires generated native files must first amend this specification instead of making the harness invent an unowned file envelope. Executable MCP commands, callable capability endpoints, and MCP credentials remain absent while the capability plane is disabled.

Trusted-relay and direct-provider routes are distinct, mutually exclusive authority envelopes. A trusted-relay AEP supplies only `OPENKIT_WORKER_INFERENCE_TOKEN` plus exact relay egress and withholds direct credentials and direct provider egress. A direct-provider AEP supplies only the manifest-declared provider credential plus exact direct egress and must not receive the relay placeholder. The adapter may reject an unsupported envelope but must never substitute the other one.

Dynamic supply changes create a new AEP snapshot.

NanoCore may deliver a safe-point supply refresh command only when the resolved AEP explicitly declares refresh support proved by the selected image and shared shim.

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

Current worker-to-NanoCore record families also include:

- schema-conformant candidate event append
- final status reporting
- supply refresh notice
- capability call notification summaries

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

S16 Stage 4 uses this existing data plane for turn-end Artifact bytes without adding a live file-transfer control family. The canonical transcript declaration contains the existing Artifact kind, non-empty title, one canonical absolute POSIX path, exact media type `text/markdown`, `text/plain`, or `application/json`, and at most one `materialProposal` tuple `{ materialId, baseRevisionId, baseContentDigest }`. Its package snapshot plus sequence supplies exact Artifact id `worker-artifact-${packageSnapshotId}-${sequence}`. The path must be a strict child of exactly one AEP output root with `registerAsArtifacts=true` and `retention=sync-on-turn-end`; path equality, traversal, non-canonical spelling, duplicate paths, ambiguous overlapping roots, and every undeclared root fail closed before canonical writes. Artifact notices remain bounded diagnostics and never replace terminal transcript plus downloaded bytes.

The shared turn-end collector accepts only non-empty well-formed UTF-8 and at most 16 MiB of aggregate Artifact bytes per Turn, parses declared JSON, and performs no newline or Unicode normalization. In declaration-sequence order it creates through the existing retained-session command boundary and downloads only a backend-owned temporary copy bounded to the remaining aggregate budget plus one sentinel byte; it rejects a larger copy immediately, never downloads the unbounded declared file directly, and therefore transfers at most 16 MiB plus one Artifact payload byte before zero-write rejection. Before any Artifact or Review write it compares every payload with every exact non-empty sensitive value injected into that worker materialization, including runtime environment, runtime file, direct-provider, worker-control, and trusted-relay values. The comparison set contains the UTF-8 bytes of each complete injected value, deduplicated by byte equality; a runtime-file entry contributes its complete content, and a match means contiguous byte-substring containment anywhere in the payload rather than whole-payload equality. Any match rejects the complete candidate set with product-safe diagnostics and zero Artifact or Review writes. Secret environment, file, and provider values remain backend-private process memory until collection or cleanup; the existing durable scheduler-owned sandbox binding reference is included without creating another record or copy. The assembled set never enters transcript or Artifact state. A restored session without the original complete set runs the existing backend cleanup lifecycle and rejects any artifact declaration as `recovery_required` instead of guessing from current credentials. As with workspace publication, this exact-value check is not generic DLP and does not detect encoded, transformed, derived, or otherwise non-literal secret material.

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

Every real worker container runs the generic `openkit-worker-shim` entrypoint. The removed runtime-specific and sidecar entrypoints are not part of the target architecture.

The shared harness owns runtime-neutral worker lifecycle behavior inside the image. A selected runtime adapter owns native translation. NanoCore owns canonical verification outside the image.

The shim should:

- read the AEP snapshot and generated files
- materialize runtime-neutral AEP files and inert MCP supply metadata without enabling executable MCP connectivity
- allocate one fresh bounded session state root without writing adapter-authored config files
- require exactly one resolved LLM route and pass its provider, model, credential-attachment, direct-control, and inference-endpoint inputs to the selected adapter without translating them into a runtime-native schema
- launch or supervise the adapter-planned Worker Agent process as a child process
- capture at most 16 MiB of ordinary native stdout for the selected adapter's `collect` buffer and fail closed on overflow; the optional S33 Codex provenance sink streams separately under S33's own declared aggregate bound and is not double-buffered here
- retain at most a 16 KiB diagnostic prefix from each ordinary stdout and stderr stream
- convert adapter-normalized results into schema-conformant candidate OpenKit transcript and event records
- write `/openkit/session/events.jsonl`, `/openkit/session/items.jsonl`, and `/openkit/session/artifacts.jsonl`
- emit heartbeat and artifact notices through direct NanoCore worker control
- append schema-conformant candidate events through direct NanoCore worker control
- write `/openkit/session/workspace-changes.json` when workspace changes are produced
- before publishing `workspace.patch` or its manifest, compare every non-deleted changed path's exact stage-zero blob bytes from the isolated Git index with every exact non-empty credential value injected into the native child environment; any match fails closed, removes transient and review outputs, and leaves that value in no patch, manifest, or transcript
- maintain sequence numbers and lineage on emitted records
- apply best-effort lightweight redaction before records leave the container
- fail before child launch when required direct-control readiness has not completed
- after readiness, keep the same child alive only during the worker-control protocol's bounded retryable outage budget, then stop or cancel it on budget expiry or terminal authority, lineage, or contract failure while retaining transcript evidence already written

The shared harness must not understand a Codex, OpenCode, Pi, or future runtime event type. It accepts only an adapter launch plan and an adapter-normalized result.

The worker-side adapter contract has only two operations:

```text
prepare(resolved adapter input) -> native launch plan
collect(native exit and bounded output) -> normalized adapter result
```

`prepare` returns native argv, safe child-environment additions, and output-capture requirements. It has no config-artifact return field. `collect` returns final assistant content and a bounded product-safe failure classification. It returns no native session metadata and creates no canonical OpenKit record.

The shared harness owns process-group termination for interruption. Native graceful-abort hooks, session continuation, steering, follow-up, and approval mapping are not part of the current adapter contract.

Codex-native provenance capture remains an optional adapter-local implementation connected to the separately owned and verified S33 provenance boundary. It is not a shared adapter operation and creates no provenance requirement for OpenCode, Pi, or a fourth runtime.

Candidate worker records become canonical product truth only after NanoCore validates their lineage, sequence, schema, policy, digest, and workspace boundaries and commits them through the owning product records.

The shim must not:

- own Workspace, Thread, Turn, Item, Goal Mode, Action Center, Knowledge Store, Review, or Apply state
- make final authorization decisions
- bypass NanoCore policy checks
- install arbitrary Skills, MCP servers, tools, packages, or credentials
- read NanoCore private storage directly
- push, publish, tag, deploy, or trigger external side effects without a NanoCore-approved path
- become a generic interactive shell

Shim redaction is best effort.

The workspace publication guard is exact-value protection only. It does not provide generic DLP or detect encoded, transformed, derived, or otherwise non-literal credential material.

NanoCore canonical verification and redaction remain the server-owned product boundary.

## Runtime Adapter Packaging

Runtime-native adapter logic lives outside NanoCore. The current package structure is:

```text
packages/worker-protocol
  canonical worker-control, transcript, item, artifact, workspace-change, capability, sequence, lineage, and error schemas

packages/worker-shim
  shared worker harness plus Codex, OpenCode, and Pi runtime adapters
```

NanoCore may depend on canonical schemas from `packages/worker-protocol`.

NanoCore should not depend on runtime-native adapter packages.

Container images may depend on the worker protocol and worker shim packages.

The static adapter registry lives in `packages/worker-shim`, not NanoCore. Adding a runtime adds one adapter module and one static registry entry; it does not extend the shared harness contract or introduce dynamic discovery, package loading, or a plugin framework.

One authored `AgentManifest` supplies the opaque adapter id, image reference, runtime binary ids and worker-local executable paths, provider and credential requirements, capabilities, and supply compatibility. Nested manifest profiles remain behavior selections rather than runtime records. NanoCore loads and projects the selected manifest data generically into an AEP.

Each runtime has one governed image definition and one entry in the existing `containers/images.json` catalog. Images may share build mechanisms, but each image installs only its manifest-declared native runtime binaries, the generic worker shim, its statically registered adapter module, and its declared smoke checks.

The three concrete adapter contracts are owned by:

- `docs/specs/20260716-codex_worker_adapter.md`
- `docs/specs/20260716-opencode_worker_adapter.md`
- `docs/specs/20260716-pi_worker_adapter.md`

## Current Implementation Projection

The current implementation is a partial projection of this broader communication model and an implemented projection of the WP-2 runtime-adapter boundary:

- `packages/worker-protocol` exists and defines canonical worker lineage, schema version, worker event records, transcript records, workspace change manifests, capability call summaries, worker-control request and response envelopes, and worker error shapes.
- `packages/worker-shim` provides one generic `openkit-worker-shim` entrypoint, one static registry, and separate Codex, OpenCode, and Pi adapters behind the two-operation `prepare` and `collect` contract. Runtime-native argv, safe child environment, state-root selection, and bounded result parsing remain adapter-owned. The shared shim has no native config-artifact contract, worker capability client, sidecar binary, or runtime-name fallback.
- Codex `0.144.1` and OpenCode `1.18.1` accept only the trusted NanoCore relay envelope. Pi `0.80.7` accepts only the exact direct Anthropic `claude-sonnet-4-5` envelope. Every adapter rejects zero or multiple routes, mixed relay and direct authority, and unsupported runtime-route combinations before child launch.
- NanoCore preserves the strict manifest-authored image, pull policy, runtime binaries, adapter id, provider selection, and sandbox envelope through `ResolvedAgentSetup`, then resolves exactly one provider route into the immutable AEP. `control.adapter.targetRuntime` alone selects the adapter; runtime kind, image name, environment, deployment, transport, and backend topology do not select or infer one.
- The active shim keeps one already launched child alive inside one bounded direct-control outage budget and reconnects that same process through the ordinary heartbeat route.
- `apps/nanocore/src/runtime/agent-environment.ts` resolves OpenShell-backed AEP snapshots with required `direct-nanocore` control and exact `worker-control` backend capability requirements. Current packages emit a disabled capability plane with no routes.
- `apps/nanocore/src/runtime/worker-control-gateway.ts`, `worker-control-records.ts`, `worker-control-sequences.ts`, `worker-control-commands.ts`, `worker-control-rejected-evidence.ts`, and `worker-control-rebuild.ts` provide the durable V1 worker-control state, sequence, command, rejection-evidence, and restart-rebuild surfaces for registered AEP snapshots.
- `apps/nanocore/src/app.ts` exposes current worker-control routes for heartbeat, artifact notice, interrupt polling and acknowledgement, event append, final status, supply-refresh acknowledgement, capability-call summary, and knowledge-proposal summary.
- NanoCore exposes no `/api/worker-capabilities/*` routes and no worker MCP gateway. `WorkerCapabilityCallSummary` remains a transcript/import schema and does not prove a callable capability route.
- `apps/nanocore/src/runtime/turn-executor-factory.ts` selects local or remote disposable OpenShell Cell placement and rejects historical host selector shapes.
- Remote placement binds one validated SSH lifecycle target to an operator-managed loopback HTTP Gateway origin and an explicit credential-free HTTP(S) `/api/worker-control` URL reachable from the sandbox.
- The public worker runtime model has only `OPENKIT_WORKER_RUNTIME=container`, `OPENKIT_CONTAINER_PLACEMENT=local|remote`, and `OPENKIT_CONTAINER_BACKEND=openshell`; historical host selectors are absent rather than recognized as compatibility inputs.
- `apps/nanocore/src/runtime/worker-governance-backend.ts` validates OpenShell control endpoints, collects transcript and workspace-change data-plane artifacts, and imports product-safe records.
- `apps/nanocore/src/runtime/filesystem-workspace-sync.ts` and related storage code implement filesystem snapshot, staging, review, and apply records that are now owned by the workspace synchronization spec.

Direct control, data collection, the generic runtime-adapter boundary, inference-route validation, evidence, and audit foundations are implemented. Static Skill and MCP supply metadata may be present, but the worker capability plane and worker MCP gateway are not implemented and remain accepted future contracts. The three pinned arm64 images build on A1 and pass stock OpenShell `0.0.80` create, upload, adapter `prepare` dry-run, and `--no-keep` cleanup checks. That evidence proves image content, preparation, containment, upload, and cleanup only; it does not prove the complete worker-control readiness, heartbeat, interrupt, reconnect, recovery, or terminal closeout lifecycle for every adapter. The trusted worker-inference and runtime-provenance extension remains governed by `docs/specs/20260711-worker_runtime_subagent_provenance.md`, whose separate real production proof has passed on A1.

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

The shim may write runtime-neutral Skill files and inert MCP supply metadata from that resolved supply. The selected adapter may derive runtime-native argv, environment bindings, and state-root paths but returns no files for the shared harness to materialize. While the capability plane is disabled, neither layer may materialize executable MCP server commands, callable endpoints, or credentials that would permit direct worker-to-MCP execution.

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

## Candidate Event Append

Live event append is required before broad worker-side Skill, MCP, knowledge, and context capabilities are considered complete.

The first live append surface should accept schema-conformant candidate worker records for:

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

After readiness, retry must preserve the same logical operation identity, worker sequence, and canonical payload fingerprint. The shim retries only the AEP-resolved worker-control base URL, pauses new command polling and new control-dependent work while disconnected, and does not create an unbounded offline outbound queue.

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

## Diagnostic Commands

No diagnostic command family is implemented or declared by the current worker contract. A future diagnostic operation requires a separately accepted closed typed contract with policy binding and bounded arguments; arbitrary argv, cwd, environment, or shell input is permanently excluded.

## Local Versus Remote Container Placement

Local and remote container placements share the same Worker-facing contract and product semantics.

They may differ only in backend transport and reachability.

Local placement uses the stock Gateway inside the co-located disposable Cell, a worker-reachable direct NanoCore endpoint, local upload and download operations, and local diagnostic commands.

Remote placement uses the same stock OpenShell `0.0.80` backend inside a remote disposable Cell. NanoCore invokes only the fixed Cell helper actions through non-interactive SSH, reaches the Cell's loopback Gateway through a separate operator-managed local forward, and supplies the exact credential-free HTTP(S) `/api/worker-control` URL that the sandbox can reach.

A naked or shared Gateway, insecure Gateway mode, custom OpenShell binary, resource-delete cleanup, fork, patch, compatibility selector, or host fallback is not a remote placement.

These differences must not leak into Worker records, public App API, end-user CLI operations, Web UI, Goal Mode, Action Center, or review semantics.

## Failure And Recovery

Before the complete direct-control readiness exchange succeeds, required control failure is fail-fast and the shim must not launch the main Worker Agent child.

Retry remains disabled until the main Worker Agent child starts, so an interruption before launch is fail-fast. After launch, a retryable direct-control interruption enters the single bounded outage budget owned by `docs/specs/20260703-worker_control_protocol.md`. The shim keeps the same child alive while pausing new command polling and new control-dependent work and retrying only the same AEP-resolved endpoint with the same logical operation identity.

Reconnect must not create another control endpoint, worker, agent session, lease, snapshot restore, or compatibility lookup. NanoCore may re-adopt only the exact durable lease, worker incarnation, AEP snapshot, control lineage, backend session, and workspace handoff proven through the scheduler and worker-control contracts.

Budget expiry, authoritative cancellation, cleanup fencing, or terminal token, lineage, sequence, policy, digest, workspace-path, or schema failure stops or cancels the worker. NanoCore should still collect transcript files already written through backend transport and import validated records as evidence.

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

Sandbox tokens and raw worker process keys do not need to be persisted as reusable secret material. Sequence zero binds only the process-key hash to the lease, while sequence one proves that post-launch retry is active and child execution has begun. Restart recovery arms only a lease with `lastWorkerSequence >= 1`; adoption then requires the original in-memory key, exact durable lineage, the exact next sequence, and the unexpired `awaiting-reconnect` lease. It adds no compatibility registry or challenge protocol.

When exact adoption succeeds, the existing worker-turn checkpoint, agent session, and workspace synchronization records continue terminal observation, evidence collection, review, and cleanup for the same turn. When key, lineage, sequence, or deadline verification fails, those same owners project the interrupted outcome and reconciliation path. The shim publishes `final_status` only after sealing runtime provenance and workspace changes, making it the last durable-output barrier. A durable accepted final status closes directly through the existing backend-session, checkpoint, workspace, turn, lease, and capacity records; no settlement coordinator or parallel domain workflow exists.

The minimal reconnect contract relies on the trusted TLS or operator-managed SSH transport already required for the bearer token. It deliberately adds no application-layer challenge. A transport observer who obtains both the bearer token and process key could race the worker, so transport confidentiality is part of the deployment boundary.

## Public Surfaces

Public App API, the end-user Agent Skill Interface, Web UI, deployment docs, and status summaries should describe:

- Core mode: `local | server`
- Worker runtime: `container`
- Container placement: `local | remote`
- Container backend: `openshell` first

They should not advertise host execution as a supported Worker runtime.

The end-user `openkit` Skill's bundled CLI is the implemented channel facade over NanoCore public APIs. It uses the transport-neutral operation catalog and does not expose a second workflow or route authority.

The transport-neutral operation catalog may need operations to inspect worker runtime status, worker communication diagnostics, supply catalog summaries, capability call summaries, and staged review evidence.

It must not become worker-side MCP supply and must not expose backend-private sandbox control.

## Implementation Roadmap

Implementation should move through these release-neutral milestones:

1. Remove host Worker runtime from product selection and public surfaces.
2. Promote canonical worker schemas into `packages/worker-protocol`.
3. Extract one shared worker harness and implement Codex, OpenCode, and Pi behind the two-operation `prepare`/`collect` adapter contract in `packages/worker-shim`.
4. Complete live candidate event append, NanoCore validation, and transcript import deduplication on direct worker control.
5. Complete NanoCore-resolved Skill and MCP supply catalog materialization into container workers.
6. Rebuild the worker capability plane, thin shim client, Knowledge Store operations, and worker MCP gateway from their accepted contracts without adding another control path.
7. Keep the unified `openkit` Skill, bundled CLI, and operation catalog aligned as public runtime-communication operations land so coordinator agents can inspect and drive them through public NanoCore APIs.
8. Verify the full local and remote loop through public NanoCore APIs and the Agent Skill Interface without relying on backend-private runtime state.

## Verification Expectations

The communication model is implemented only when:

- no real product runtime path uses host execution
- local and remote container placements generate equivalent AEP worker-facing control contracts
- local and remote container placements use the same direct worker-control protocol, transcript schema, event schema, disabled capability declaration, and workspace-change schema
- NanoCore validates candidate records against canonical schemas without importing runtime-native adapters
- Runtime adapters own runtime-native argv, environment, isolated state paths, and output parsing; the shared harness has no native config-file contract
- a fourth-runtime fixture adds one authored `AgentManifest`, one adapter module plus static registry entry, and one image definition plus existing-catalog entry without modifying NanoCore product, governance, canonical protocol, or shared-harness behavior
- base-path runtime-native command construction and event parsing occur only in the corresponding adapter, specification, and tests; images and manifests declare binaries and policy but no native argv, native session metadata is not retained, and the only NanoCore native-parser exception is the narrowly isolated version-pinned S33 verifier
- Skill and MCP supply comes from NanoCore-resolved catalog snapshots
- the future worker capability plane passes governed Knowledge Store, context, MCP, and proposal-flow acceptance before it is advertised
- no App API, NanoCore route, gateway method, or worker shim accepts or executes caller-supplied arbitrary argv, cwd, environment, or shell input
- tests prove token, lineage, schema, sequence, idempotency, digest, workspace path, and policy validation
- tests prove pre-readiness failure launches no worker, retryable post-readiness interruption preserves the same worker within the bounded budget, exact process-key/lineage/sequence adoption creates no replacement worker or session, and budget expiry enters the existing interrupted recovery path
- e2e smoke proves the local disposable Cell can run one bounded Goal Mode worker step, produce reviewable evidence, recycle the complete runtime, and return a fresh stable-empty Cell
- remote backend e2e proves fixed SSH prepare and recycle, stock Gateway preflight, sandbox materialization, data transport, and a fresh empty replacement Cell
- real Codex provenance acceptance proves the complete attributed remote worker path; that gate has passed on A1, while this broader communication spec remains partial for the independently disabled worker capability plane and MCP gateway
- Agent-Skill-driven dogfood loops prove the coordinator can inspect runtime status, run bounded steps, review evidence, and continue/refine/reject/accept without bypassing review gates

## Testing Strategy

Required local development machine verification:

- format and static checks for touched packages
- schema and contract tests for `packages/worker-protocol`, `packages/config-schema`, `packages/app-api-schemas`, and `packages/core-client`
- NanoCore unit and black-box tests for runtime selection, AEP generation, direct worker-control routes, event append, transcript import, workspace validation, and Action Center review projection
- worker-shim tests for direct control, exact one-route enforcement, transcript writing, redaction, bounded output, and sequence handling, plus adapter-local tests for native argv, environment isolation, and parser behavior
- worker-shim and NanoCore restart tests for pre-readiness fail-fast behavior, same-operation replay, paused command polling, same-worker adoption, recovery timeout, and terminal handoff through existing checkpoint, session, and workspace records
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

Mitigation: keep the direct route limited to the worker-control protocol, expose only the current typed interrupt command, and implement capabilities on their separate future plane.

Risk: Worker-side MCP bypasses NanoCore policy.

Mitigation: advertise no worker capability route until NanoCore-resolved MCP catalog snapshots, gateway policy, and the thin `capability.local` client pass acceptance.

Risk: Remote recovery after NanoCore restart adopts the wrong worker or extends an outage indefinitely.

Mitigation: require the exact memory-only process key, durable lineage, next sequence, and preserved deadline; claim reconnect and apply the ordinary heartbeat update in one database transaction while timeout cleanup uses one exact-row CAS, so only one side can win; fall back to the existing interrupted-evidence path on any mismatch or timeout.

## Decisions

- Host runtime is removed from product execution and public surfaces.
- Public runtime configuration should move to `OPENKIT_WORKER_RUNTIME=container`, `OPENKIT_CONTAINER_PLACEMENT=local|remote`, and `OPENKIT_CONTAINER_BACKEND=openshell`.
- Direct NanoCore `/api/worker-control` is the only worker-control endpoint. The accepted future `capability.local` projection is a separate plane and must not carry control traffic.
- The AEP resolves one specialized LLM route, while its runtime-native projection is adapter-specific and fail-closed. Codex `0.144.1` and OpenCode `1.18.1` can represent the trusted NanoCore relay within the current no-file contract; Pi `0.80.7` cannot and supports only an exact pinned native direct provider/model pair.
- `openkit-worker-shim` is the generic real container entrypoint; runtime-native behavior is selected by the AEP-declared opaque adapter id inside the worker image.
- Codex, OpenCode, and Pi use one shared harness contract and separate runtime adapters.
- One authored `AgentManifest`, one adapter module plus static registry entry, and one governed image definition plus existing-catalog entry are the complete permitted production extension surface for a fourth Worker Agent.
- The shared adapter contract is only `prepare` and `collect`; shared process-group termination owns interruption, native session metadata is not retained, and native output uses the 16 MiB capture and 16 KiB-per-stream diagnostic-prefix bounds.
- Worker capability and executable MCP routes remain disabled until their owning specifications are implemented and proven; static supply does not authorize direct execution.
- S33 Codex provenance remains a separate optional verified extension and is not part of the common adapter contract.
- Live candidate event append and NanoCore validation should be implemented before broad Skill, MCP, knowledge, and context capability work.
- Dynamic Skill and MCP updates create new AEP snapshots and refresh only at safe points when explicitly supported.
- Shim redaction is best effort; NanoCore redaction and verification remain authoritative.
- No diagnostic command exists in the current contract; any future typed diagnostic is separately designed and cannot accept arbitrary execution input.
- Required direct control is fail-fast before readiness and bounded-reconnect after readiness; successful process-key adoption continues the same worker and existing terminal-handoff records, while verification failure or timeout follows the existing interrupted recovery path.

## Specialized Decision Index

This overview records the worker runtime communication direction. Detailed implementation decisions live in the narrower specs that own each contract:

- Worker-control live append route shape, envelope semantics, event sequence idempotency, stale/conflicting sequence handling, and response fields are owned by `docs/specs/20260703-worker_control_protocol.md`.
- Runtime-internal sub-agent raw capture, parent-child provenance, trusted worker-inference identity, and runtime cache lineage are owned by `docs/specs/20260711-worker_runtime_subagent_provenance.md`.
- Worker capability route projection, canonical `knowledge.*` target families, sandbox bearer lineage, `WorkerCapabilityCallSummary`, metering, and audit hooks are owned by `docs/specs/20260703-worker_agent_capability.md` and `docs/specs/20260702-knowledge_store_governance_rules.md`.
- Worker-side Skill and MCP catalog resolution, approved catalog ids, version or digest resolution, runtime-adapter compatibility, and provider and vault references are owned by `docs/specs/20260703-agent_manifest_aep_resolution.md` and `docs/specs/20260616-agent_environment_package.md`; adapter-specific native argv, safe environment, state-root use, and output parsing are owned by S64-S66 and their future peer specifications.
- Filesystem workspace staging, resolved-path containment, symlink escape rejection, staged review, apply, and recovery behavior are owned by `docs/specs/20260703-workspace_synchronization.md`.
- End-user coordinator diagnostics must use public NanoCore App API surfaces rather than runtime internals. Concrete Skill guidance and CLI operations are owned by `docs/specs/20260713-openkit_agent_skill_interface.md`.
- OpenShell network policy defaults, Codex binary allowlists, Git remote helper binary allowlists, and disposable Cell lifecycle details are owned by `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`, `docs/specs/20260703-workspace_synchronization.md`, and NanoCore runtime implementation docs.
- Restart effects use ordinary worker-control adoption plus the existing workspace synchronization, evidence-import, and bounded-step owners; no separate recovery workflows or coordinators exist. Detailed rules are owned by `docs/specs/20260703-worker_control_protocol.md`, `docs/specs/20260703-workspace_synchronization.md`, `docs/specs/20260703-audit_usage_evidence_records.md`, and `docs/specs/20260703-runtime_scheduling_scale.md`.

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
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
- `docs/specs/20260703-runtime_scheduling_scale.md`
