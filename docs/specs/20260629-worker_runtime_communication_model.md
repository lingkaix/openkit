---
status: Accepted
implementation: Partial
updated: 2026-09-06
---
# Worker Runtime Communication Model

## Summary

OpenKit removes host execution as a real Worker Agent runtime and standardizes real Worker Agent execution on governed container runtimes.

NanoCore owns product state, policy, review, audit, verification, and validated record import.

Every real Worker Agent runs inside a governed container runtime and communicates only through sandbox-local Sandbox Integration interfaces, regardless of whether NanoCore and the NanoHost are co-located or remote.

Runtime-native differences belong inside the worker container behind Sandbox Integration and its runtime adapter.

NanoCore receives schema-conformant candidate OpenKit worker records, verifies lineage, schema, sequence, policy, digest, and workspace boundaries, and commits accepted records into the `Workspace -> Thread -> Turn -> Item[]` product model.

## Carriage, Normalization, And Acceptance

Turning worker activity into product records is three distinct jobs with three distinct owners. Conflating any two of them is how either the substrate acquires product authority or the sandbox acquires acceptance authority, so this specification names them separately and assigns each exactly once. The Core rule they realize is the substrate doctrine in `docs/core/runtime-model.md`.

| Job | Owner | Boundary |
| --- | --- | --- |
| **Carriage** — moving well-formed envelopes with their sequence and lineage | Sandbox Integration as the client, the execution runtime as byte-transparent transport | Neither may inspect, authorize, synthesize, retry, reorder, reinterpret, or terminalize a message. The runtime moves bytes and adds no meaning. |
| **Normalization** — mapping runtime-native activity into OpenKit record shapes | The sandbox-local runtime adapter behind Sandbox Integration | It produces candidates only. It decides no item boundary that NanoCore has not defined, and it MUST NOT be relied on as the integrity boundary. |
| **Acceptance and storage** — verifying candidates and committing canonical truth | NanoCore alone | Acceptance is a separate act from normalization and may reject any candidate. No other participant may accept, publish, or store canonical product truth. |

### Normalization Happens In The Least-Trusted Place

Normalization deliberately runs inside the worker sandbox, because it needs the runtime-native event stream, and that stream is voluminous and runtime-specific. Lifting it out would put raw native events on the control transport, which would exceed the accepted transport bounds and move bytes that are not truth across a boundary whose purpose is to carry only truth-bearing candidates. Keeping it in the sandbox is the correct trade.

The cost of that trade MUST be stated rather than assumed: the component doing the shaping is the least-trusted component in the system. A compromised or malfunctioning worker can emit arbitrary well-formed candidates. Sandbox-side normalization is therefore not an integrity boundary, and NanoCore's verification is the only one.

Accordingly, NanoCore MUST verify every candidate against authority it already holds rather than against anything the candidate asserts about itself: exact lineage, monotonic sequence for the sequenced operations, schema conformance, declared digests, workspace boundaries, and the exact adapter identity the resolved launch authority named. A candidate whose adapter identity does not match the one the package snapshot selected is rejected, because a record shaped by an adapter the launch never authorized has unknown provenance regardless of how well-formed it is.

Rejection is truthful and terminal for that candidate. NanoCore MUST NOT repair, coerce, partially accept, or infer a corrected shape, and a rejected candidate MUST NOT be retried into acceptance by resubmission under a different shape.

This document is the release-neutral overview for worker runtime communication. Concrete worker-control operations are owned by `docs/specs/20260703-worker_control_protocol.md`. Concrete capability-plane routes are owned by `docs/specs/20260703-worker_agent_capability.md`. Concrete workspace staging and synchronization are owned by `docs/specs/20260703-workspace_synchronization.md`.

## Owns

- The high-level worker runtime communication model for governed container workers.
- The projection of worker communication onto Core's closed Control, Workspace, Artifact, and Capability planes.
- The worker-facing container contract that hides NanoHost deployment topology from Worker Agents.
- The Sandbox Integration responsibility boundary between worker-runtime adaptation and NanoCore-owned product verification.
- The Sandbox Integration outer-adapter boundary that projects separate worker-control, inference, and capability protocols onto sandbox-local interfaces.
- The rule that host execution is not a product Worker Agent runtime.
- The release-neutral packaging direction for worker protocol schemas, Sandbox Integration, and runtime adapters.

## Does Not Own

- Concrete worker-control operation schemas, route semantics, and persistence rules.
- Concrete worker capability route schemas, metering, and gateway records.
- AEP schema fields or manifest resolution.
- Runtime scheduling, warm pools, queueing, capacity, or placement decisions.
- Workspace synchronization record schemas, staging review, and apply semantics.
- Permission policy semantics, vault storage, audit storage, usage storage, or Knowledge Store governance.
- Release plans, environment-specific rollout steps, or change-record lifecycle tracking.
- NanoHost identity or transport, Runtime Epoch lifecycle, OpenShell supervision, RelayStream feasibility, route-family wire schemas, or credential lifecycle.

## Core References

- `docs/core/runtime-model.md`
- `docs/core/communication.md`
- `docs/core/agent-session.md`
- `docs/core/agent-capability.md`
- `docs/core/agent-supply.md`
- `docs/core/sandbox.md`
- `docs/core/storage.md`
- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/core/protocol.md`
- `docs/core/knowledge.md`

## Goals

- Remove host execution as a product runtime, deployment mode, and communication path.
- Keep deterministic test fixtures available without treating them as real Worker runtimes.
- Define one Worker-facing communication contract for every governed container.
- Keep NanoHost deployment topology outside the Worker Agent behind the NanoHost and Sandbox Integration projection.
- Require Sandbox Integration in every real worker container.
- Preserve an already launched worker through bounded NanoCore transport interruption and exact end-to-end worker-control reconnect without creating an alternate control path, replacement worker, replacement sandbox, or replacement session.
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
- Do not make Sandbox Integration a second NanoCore, a product state owner, a review decision engine, or a generic shell daemon.
- Do not mix the end-user Agent Skill Interface with worker-side MCP capability supply.
- Do not allow sandbox workers to push, publish, tag, deploy, or mutate protected branches without NanoCore-owned review and apply gates.
- Do not keep historical host runtime configuration shapes as supported product behavior.

## Runtime Model

OpenKit separates Core mode from NanoHost deployment topology.

Core mode remains:

```text
local | server
```

The real Worker runtime model is:

```text
Worker runtime: container
Runtime target: one configured NanoHost
Container backend: stock OpenShell owned privately by NanoHost
```

NanoCore exposes no worker-runtime, container-placement, backend, SSH lifecycle, Gateway, or sandbox-direct endpoint selector. Internal durable records may retain scheduler placement and backend facts, but those facts are not deployment configuration or caller authority.

An AgentManifest owns runtime supply but no `mode`, `deployment`, or `transport`; configured NanoHost identity and deployment remain server configuration. Gateway origin, SSH lifecycle target, direct NanoCore endpoint, and transport credentials are not target manifest or Worker fields.

Host execution may exist only as deterministic test doubles, fixture executors, or in-process harnesses that cannot be selected through product configuration, the end-user Agent Skill Interface, Web UI, deployment docs, status summaries, or public capability flags.

## Worker-Facing Contract

Every real Worker Agent sees the same contract inside its container:

```text
/openkit/config/package.json
/openkit/session/events.jsonl
/openkit/session/items.jsonl
/openkit/session/artifacts.jsonl
/openkit/session/workspace-changes.json
<AEP-resolved sandbox-local /worker-control/* Integration binding>
<AEP-resolved sandbox-local /inference/* Integration binding>
<AEP-resolved sandbox-local /capabilities/* Integration binding when enabled>
declared workspace roots
declared output roots
```

The Worker Agent should not know whether the container is local or remote.

The Worker Agent should not know raw NanoCore host paths, raw remote gateway URLs, raw OpenShell gateway internals, raw backend upload/download handles, raw secrets, or private data-root paths.

The Worker Agent receives an Agent Environment Package snapshot, local files generated from that snapshot, non-secret sandbox-local route bindings and token references, declared workspace roots, and declared output roots. It never receives a NanoHost credential, raw route token, remote NanoCore or Gateway address, SSH target, Gateway forward, Runtime Epoch identity, upstream MCP topology, or direct sandbox-to-NanoCore endpoint. Current AEPs with selected MCP supply enable exactly the three governed MCP operations through `/capabilities/*`; every package without that supply declares the capability plane disabled with no routes.

## Communication Planes

### Static Supply Projection

NanoCore resolves agent setup into an Agent Environment Package snapshot before launch.

Static supply is a pre-launch setup projection, not an additional communication plane.

The AEP snapshot carries lineage, selected runtime, workspace inputs, generated files, Skill refs, worker-safe selected MCP supply refs, a preferred logical-model ID, an exact allowed logical-model set, non-secret local Integration bindings and token references, an exact capability declaration, policy summaries, and backend capability requirements. The capability declaration enables only `mcp.list_servers`, `mcp.list_tools`, and `mcp.call_tool` when selected MCP supply is non-empty and is otherwise disabled with no routes. Every worker inference request names one member of the immutable model set; NanoCore validates membership at the worker inference boundary before Gateway dispatch. A missing or disallowed logical model returns the typed `worker_logical_model_not_allowed` failure without Provider effects, and neither Sandbox Integration nor the runtime adapter sees or selects a concrete route.

The backend materializes the AEP snapshot into the container.

The selected worker adapter converts resolved AEP inputs into runtime-native argv and safe environment bindings. Each adapter must prove that its pinned runtime can represent the logical-model IDs, local inference endpoint, credential placeholder, and wire protocol without receiving Provider identity. An unsupported runtime or logical-model-catalog pairing fails closed before child launch rather than being normalized, inferred, or replaced.

Neither adapter mode has an adapter-returned config-artifact field. The shared Harness materializes only runtime-neutral AEP files and rejects any attempt to introduce adapter-authored files through a launch plan. A `bounded-turn` adapter receives one fresh Turn-scoped state root that is removed after collection; a `session-continuity` adapter receives one private AgentSession state root plus fresh Turn-local output slots and retains only its restricted native handle state until `closeSession`. Codex, OpenCode, and Pi express native setup only through adapter-owned argv and safe environment bindings; a future runtime that requires generated native files must first amend this specification instead of making the Harness invent an unowned file envelope. Upstream MCP commands, endpoints, credential references, and credentials always remain absent from the worker. When selected MCP supply enables the capability plane, the Codex adapter projects only fixed loopback server URLs and the capability token environment-key name; no selected supply keeps those projections absent.

Worker inference uses only the trusted logical Gateway relay. The AEP supplies `OPENKIT_WORKER_INFERENCE_TOKEN` plus exact local inference egress and withholds concrete Provider credentials, Provider endpoints, account identities, and direct Provider egress. Direct-provider worker inference is not part of this target. Separately declared non-LLM tool and service egress remains ordinary AEP Sandbox policy: an exact grant may authorize only its named runtime binary and endpoint and does not become Provider authority or an inference-relay exception.

Dynamic supply changes create a new AEP snapshot.

NanoCore may deliver a safe-point supply refresh command only when the resolved AEP explicitly declares refresh support proved by the selected image and Sandbox Integration.

When refresh support is absent or uncertain, NanoCore must finish or stop the current bounded step and launch the next step with the new AEP snapshot.

### Control Plane

The control plane uses `openkit-worker-control-v2` end to end.

The worker-visible endpoint is the AEP-resolved sandbox-local `/worker-control/*` Integration binding. Sandbox Integration is the outer adapter, not a capability gateway or Core participant. Its outer carriage adapter carries the unchanged protocol through one standard HTTP/2 session inside one stock OpenShell RelayStream; it does not authorize, inspect, retry, reorder, or reinterpret worker-control messages. The worker-control client inside Sandbox Integration applies only the retry semantics owned by the worker-control protocol.

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

Every control request must carry its worker-control token authentication and lineage. That token is accepted only by `/worker-control/*` and is never reused for `/inference/*` or `/capabilities/*`.

Lineage includes Workspace id, Thread id, Turn id, AgentSession id, package snapshot id, and request id when available.

Every ordered worker-emitted record must carry a monotonic worker sequence number.

NanoCore must reject token, lineage, sequence, idempotency, policy, digest, workspace path, and schema violations fail-closed with redacted diagnostics.

### Workspace And Artifact Plane Projections

The Workspace plane supplies workspace inputs, while the Artifact plane returns generated outputs and collected changes through backend transport rather than the control channel.

Examples include workspace snapshots, Git checkouts, tar bundles, patches, commit bundles, changed-file manifests, generated artifacts, raw or summarized logs, and backend evidence.

For OpenShell, this can use sandbox upload, sandbox download, sandbox exec, retained session directories, and future OpenShell file primitives.

For future backends, this can use bind mounts, `docker cp`, tar streams, object storage, provider file APIs, or managed sandbox file APIs.

NanoCore must normalize collected data into OpenKit records such as `WorkspaceInputSnapshot`, `WorkspaceMaterializationRecord`, `WorkspaceChangeSet`, `StagedWorkspaceReview`, `WorkspaceApplyResult`, `Artifact`, `Evidence`, and Action Center rows.

The control plane may announce that Workspace or Artifact data is ready, but it must not carry full patches, bundles, artifact files, or raw logs except within strict product metadata limits.

S16 Stage 4 uses these Workspace and Artifact projections for turn-end Artifact bytes without adding a live file-transfer control family. The canonical transcript declaration contains the existing Artifact kind, non-empty title, one canonical absolute POSIX path, exact media type `text/markdown`, `text/plain`, or `application/json`, and at most one `materialProposal` tuple `{ materialId, baseRevisionId, baseContentDigest }`. Its package snapshot plus sequence supplies exact Artifact id `worker-artifact-${packageSnapshotId}-${sequence}`. The path must be a strict child of exactly one AEP output root with `registerAsArtifacts=true` and `retention=sync-on-turn-end`; path equality, traversal, non-canonical spelling, duplicate paths, ambiguous overlapping roots, and every undeclared root fail closed before canonical writes. Artifact notices remain bounded diagnostics and never replace terminal transcript plus downloaded bytes.

The shared turn-end collector accepts only non-empty well-formed UTF-8 and at most 16 MiB of aggregate Artifact bytes per Turn, parses declared JSON, and performs no newline or Unicode normalization. In declaration-sequence order it creates through the existing retained-session command boundary and downloads only a backend-owned temporary copy bounded to the remaining aggregate budget plus one sentinel byte; it rejects a larger copy immediately, never downloads the unbounded declared file directly, and therefore transfers at most 16 MiB plus one Artifact payload byte before zero-write rejection. Before any Artifact or Review write it compares every payload with every exact non-empty sensitive value injected into that worker materialization, including runtime environment, runtime file, direct-provider, worker-control, and trusted-relay values. The comparison set contains the UTF-8 bytes of each complete injected value, deduplicated by byte equality; a runtime-file entry contributes its complete content, and a match means contiguous byte-substring containment anywhere in the payload rather than whole-payload equality. Any match rejects the complete candidate set with product-safe diagnostics and zero Artifact or Review writes. Secret environment, file, and provider values remain backend-private process memory until collection or cleanup; the existing durable scheduler-owned sandbox binding reference is included without creating another record or copy. The assembled set never enters transcript or Artifact state. A restored session without the original complete set runs the existing backend cleanup lifecycle and rejects any artifact declaration as `recovery_required` instead of guessing from current credentials. As with workspace publication, this exact-value check is not generic DLP and does not detect encoded, transformed, derived, or otherwise non-literal secret material.

### Capability Plane

The capability plane gives Worker Agents governed access to privileged services through the separately authenticated sandbox-local `/capabilities/*` Integration family when that family is enabled.

The accepted outer transport namespace is `/capabilities/*`. The current AEP projection enables exactly `mcp.list_servers`, `mcp.list_tools`, and `mcp.call_tool` when the immutable package contains selected MCP supply; a package without selected MCP supply is exactly `capabilities.mode: disabled` with `routes: []`.

The implemented capability family is the selected worker-side MCP slice. Future families include Knowledge Store search, Knowledge Store read, context retrieval, external API calls, network proxy access, and other non-LLM tools.

NanoCore owns routing, policy checks, credential references, redaction, metering, audit summaries, and upstream error normalization.

Worker Agents must not access NanoCore internals, SQLite files, raw data roots, raw secrets, upstream MCP topology, or arbitrary network sources to obtain capabilities. Selected MCP calls use only the fixed authenticated loopback Integration projection and NanoCore Gateway; all undeclared capability routes remain non-callable.

Every Worker Agent runtime that expects an OpenAI-style base URL receives the sandbox-local `/inference/*` Integration binding from its AEP. The inference token, model and provider scope, bounds, failure semantics, usage, and audit remain independent from worker control and capabilities.

The target binding has one fixed native projection: `http://127.0.0.1:17892/inference/v1`. Sandbox Integration owns that loopback-only HTTP/1 listener separately from the stock Supervisor bridge at `127.0.0.1:17891`. Only after its outer HTTP/2 session is ready may the native listener admit requests, and those accept only authenticated `POST /inference/*` and forward them through that session without changing the path, body, bearer token, end-to-end headers, content encoding, or response bytes. The local request aggregate is at most 16 MiB; carriage retains the 2 MiB family in-flight ceiling and 64 KiB maximum write owned by the NanoHost transport specification. Response bodies, including SSE, remain streaming with backpressure and cancellation rather than receiving a new aggregate buffer or retry. Worker-control, capability, absolute-form, unauthenticated, and non-`POST` requests are rejected locally before an outer stream opens. The native projection creates no second bridge, NanoHost route, egress grant, DNS name, AEP-selected URL, provider authority, durable state, or retry owner.

The AEP-resolved logical-model relay and token reference are specialized for inference and must not be reused for control, knowledge, MCP, vault, or generic capability traffic.

Inference is a specialization of the Capability plane, not an additional communication plane.

The selected MCP plane reuses the existing server-side policy, CapabilityCall ledger, usage, audit, and Vault owners while retaining its separate worker-facing wire contract; future capability families require their own accepted owner and implementation slice.

### Audit And Evidence Cross-Cutting Projection

Audit and evidence are cross-cutting projections over the four communication planes, not additional planes. They record what was launched, what policy was applied, what the backend did, what the worker reported, what changed, and what a human reviewed.

Sandbox Integration may produce normalized audit events and transcript records.

The backend may collect backend-native logs and transport evidence.

NanoCore verifies and stores product-safe summaries and evidence references.

Public App API, end-user Agent Skill Interface, and Web UI surfaces expose OpenKit ids, summaries, digests, artifact ids, review ids, and next suggested actions rather than backend-private internals.

## Sandbox Integration

Every real worker container runs Sandbox Integration, whose current implementation seed is the generic `openkit-worker-shim` entrypoint plus its runtime adapter. The removed runtime-specific and sidecar entrypoints are not part of the target architecture.

Sandbox Integration owns only outer transport adaptation, injection of already-resolved local bindings, and runtime-neutral worker lifecycle behavior inside the image. A selected runtime adapter owns native translation. NanoCore owns canonical verification outside the image. Sandbox Integration is not a capability gateway, scheduler, policy owner, provider selector, usage owner, audit owner, or second Core.

Sandbox Integration should:

- read the AEP snapshot and generated files
- materialize runtime-neutral AEP files and inert MCP supply metadata without enabling executable MCP connectivity
- allocate one private bounded state root per open AgentSession, retain it only until exact AgentSession close, and allocate fresh Turn-local output and credential slots beneath that binding
- require one preferred logical model and one exact allowed logical-model set and pass only those IDs, the Gateway token placeholder, the sandbox-local worker-control binding, and the sandbox-local inference binding to the selected adapter without translating them into a Provider-native schema
- launch or supervise the adapter-planned Worker Agent process as a child process
- capture at most 16 MiB of ordinary native stdout for the selected adapter's `collect` buffer and fail closed on overflow; the optional S33 Codex provenance sink streams separately under S33's own declared aggregate bound and is not double-buffered here
- retain at most a 16 KiB diagnostic prefix from each ordinary stdout and stderr stream
- convert adapter-normalized results into schema-conformant candidate OpenKit transcript and event records
- write `/openkit/session/events.jsonl`, `/openkit/session/items.jsonl`, and `/openkit/session/artifacts.jsonl`
- emit heartbeat and artifact notices through the route-bound `/worker-control/*` family exposed by Sandbox Integration
- append schema-conformant candidate events through the route-bound `/worker-control/*` family exposed by Sandbox Integration
- write `/openkit/session/workspace-changes.json` when workspace changes are produced
- before publishing `workspace.patch` or its manifest, compare every non-deleted changed path's exact stage-zero blob bytes from the isolated Git index with every exact non-empty credential value injected into the native child environment; any match fails closed, removes transient and review outputs, and leaves that value in no patch, manifest, or transcript
- maintain sequence numbers and lineage on emitted records
- apply best-effort lightweight redaction before records leave the container
- fail before child launch when required route-bound worker-control readiness has not completed
- after readiness, keep the same child alive only during the worker-control protocol's bounded retryable outage budget, then stop or cancel it on budget expiry or terminal authority, lineage, or contract failure while retaining transcript evidence already written

The shared Harness must not understand a Codex, OpenCode, Pi, or future runtime event type. It accepts only adapter-owned continuity proof, a native launch plan, and an adapter-normalized result. One Harness may hold multiple AgentSession bindings for distinct Threads and supervise one independent native Agent process per active binding; process identity is private execution state and never substitutes for AgentSession identity or `NativeConversationHandle` proof. One Thread has at most one resident current AgentSession binding.

The worker-side adapter registry has two closed modes. A `bounded-turn` adapter retains the existing two operations and is ineligible for the shared-Harness RuntimeTarget:

```text
prepare(resolved adapter input) -> native launch plan
collect(native exit and bounded output) -> normalized adapter result
```

A `session-continuity` adapter proves the current shared-Harness contract through exactly these five adapter operations:

```text
openSession(resolved static input, private session root) -> pending-or-ready native handle proof
prepareTurn(fresh resolved Turn input, prior native handle proof) -> native launch plan
collectTurn(native exit and bounded output) -> normalized result plus exact native handle proof
inspectSession(prior native handle proof) -> bounded liveness, identity, and cleanup proof
closeSession(prior native handle proof) -> exact private-state absence proof
```

`openSession` may return `pending` only when the pinned runtime creates its conversation with the first prompt; the first successful `collectTurn` must then establish one exact restricted handle before the binding becomes reusable. `prepareTurn` returns native argv, safe child-environment additions, output-capture requirements, and no config-artifact field. A later Turn may start a new native process against the same handle and session-local state. `collectTurn` returns final assistant content, bounded product-safe failure classification, and only the handle digest and state needed for Harness proof; the raw native handle remains restricted inside the AgentSession binding and creates no canonical OpenKit record.

The shared Harness owns process-group termination for exact `turn.interrupt`. Its required closed purpose is `interrupt` or `human-gate`; only `human-gate` maps the stopped child to the adapter-normalized `blocked/ask_user` result needed by an already durable exact Core Gate, while ordinary `interrupt` keeps interrupted/aborted semantics and no free-text inference is allowed. An adapter declares session continuity only when its accepted owner and selected image prove open or first-Turn establishment, same-conversation resume, inspection, session-local state isolation, process replacement, and close cleanup. Steering, follow-up, native approvals, arbitrary adapter operations, and capability inference remain absent.

Codex-native provenance capture remains an optional adapter-local implementation connected to the separately owned and verified S33 provenance boundary. It is not a shared adapter operation and creates no provenance requirement for OpenCode, Pi, or a fourth runtime.

Candidate worker records become canonical product truth only after NanoCore validates their lineage, sequence, schema, policy, digest, and workspace boundaries and commits them through the owning product records.

Sandbox Integration must not:

- own Workspace, Thread, Turn, Item, Goal Mode, Action Center, Knowledge Store, Review, or Apply state
- make final authorization decisions
- bypass NanoCore policy checks
- install arbitrary Skills, MCP servers, tools, packages, or credentials
- read NanoCore private storage directly
- push, publish, tag, deploy, or trigger external side effects without a NanoCore-approved path
- become a generic interactive shell

Sandbox Integration redaction is best effort.

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

The current implementation is a partial projection of this broader communication model. The facts in this subsection describe code and completed local evidence only; they do not replace the owning acceptance predicates or refreshed real-host proof:

- `packages/worker-protocol` exists and defines canonical worker lineage, schema version, worker event records, transcript records, workspace change manifests, capability call summaries, worker-control request and response envelopes, and worker error shapes.
- `packages/worker-shim` provides one generic zero-argument `openkit-worker-shim` entrypoint, one static registry, the implemented `bounded-turn` `prepare` and `collect` contract for OpenCode and Pi, and the implemented five-operation `session-continuity` adapter contract for Codex. Its one concrete shared Harness admits independent Codex AgentSessions for distinct Threads, runs at most one active Turn, retains only each AgentSession's restricted native handle, resumes the exact Codex thread UUID in a fresh process, and uses the existing process-group supervisor. Runtime-native argv, safe child environment, state-root selection, bounded result parsing, and selected fixed-loopback MCP projection remain adapter-owned. The shared shim has no native config-artifact contract, generic capability client, sidecar binary, or runtime-name fallback.
- Codex `0.153.4` and OpenCode `1.18.1` accept only the trusted NanoCore relay envelope. Pi `0.85.1` accepts only the exact direct Anthropic `claude-sonnet-4-5` envelope. Every adapter rejects zero or multiple routes, mixed relay and direct authority, and unsupported runtime-route combinations before child launch.
- NanoCore preserves the strict manifest-authored image, pull policy, runtime binaries, adapter id, logical-model admission, and Sandbox envelope through `ResolvedAgentSetup`, then projects the preferred and exact allowed logical-model IDs into the immutable AEP. `control.adapter.targetRuntime` alone selects the adapter; runtime kind, image name, environment, deployment, transport, and backend topology do not select or infer one.
- The zero-argument Harness keeps one Integration client alive inside the bounded outage budget, may hold multiple Codex AgentSession bindings, and launches one fresh native process for each admitted Turn; the production binary has no package-argument or one-shot compatibility path.
- `apps/nanocore/src/runtime/agent-environment.ts` resolves OpenShell-backed AEP snapshots with the fixed sandbox-local Integration control binding and exact `worker-control` backend capability requirements. Current packages enable only the three selected MCP routes when MCP supply is non-empty and otherwise emit a disabled capability plane with no routes.
- `apps/nanocore/src/runtime/worker-control-gateway.ts`, `worker-control-records.ts`, `worker-control-sequences.ts`, `worker-control-commands.ts`, `worker-control-rejected-evidence.ts`, and `worker-control-rebuild.ts` provide the durable V1 worker-control state, sequence, command, rejection-evidence, and restart-rebuild surfaces for registered AEP snapshots.
- `apps/nanocore/src/app.ts` exposes current worker-control routes for heartbeat, artifact notice, interrupt polling and acknowledgement, event append, final status, supply-refresh acknowledgement, and capability-call summary.
- NanoCore exposes the private exact server-list route and per-selected-server MCP Streamable HTTP route under `/api/worker-capabilities/mcp/*`; its MCP Gateway owns bounded stdio and HTTP upstreams, schema snapshots, policy, approval, Vault resolution, usage, audit, health, and teardown. `WorkerCapabilityCallSummary` remains the bounded transcript/import projection of durable call state rather than route authority.
- `apps/nanocore/src/runtime/turn-executor-factory.ts` selects only the configured NanoHost RuntimeTarget, reuses one compatible Sandbox and Harness across independent Codex AgentSessions, materializes fresh Turn package and Context inputs, and contains no alternate runtime selector fields.
- The public Worker runtime model selects only container execution through NanoHost; alternate lifecycle and endpoint selectors are absent.
- `apps/nanocore/src/runtime/worker-governance-backend.ts` owns the backend contract, canonical AEP import bytes, staged-export validation, policy projection, and Artifact declaration validation consumed by the NanoHost executor.
- `apps/nanocore/src/runtime/filesystem-workspace-sync.ts` and related storage code implement filesystem snapshot, staging, review, and apply records that are now owned by the workspace synchronization spec.

The control route, data collection, runtime-adapter boundary, inference-route validation, selected MCP capability plane, evidence, and audit foundations are implemented. Static Skill metadata grants no callable route, while selected MCP supply enables only its three governed operations. Current arm64 images build locally and pass their complete image smoke checks. The trusted worker-inference and runtime-provenance extension remains governed by `docs/specs/20260711-worker_runtime_subagent_provenance.md`, whose separate real production proof has passed on A1.

NanoHost, Runtime Epoch ownership, Sandbox Integration, stock RelayStream, standard HTTP/2 carriage, private Harness control, and the three outer sandbox-local route families are implemented. The fixed native HTTP/1 projection at `127.0.0.1:17892` carries authenticated inference and enabled selected-MCP requests through distinct tokens and bounds; Codex uses both exact adapter-owned URL families, OpenCode uses only inference, and Pi retains its separately owned direct-provider route and remains ineligible for this target. The required A1 NanoCore restart, NanoHost fail-stop, execution-server restart, Gateway failure, ordinary lifecycle, and Aggregate acceptance scenarios pass; R058 release closure still requires its own final packaged and deterministic story evidence.

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

Sandbox Integration may write runtime-neutral Skill files and inert MCP supply metadata from that resolved supply. The selected adapter may derive runtime-native argv, fixed loopback bindings, safe environment bindings, and state-root paths but returns no files for the shared harness to materialize. Neither layer may materialize upstream MCP server commands, endpoints, credential references, or credentials; a disabled package projects no callable endpoint, and an enabled selected-MCP package permits only the fixed authenticated Integration route.

Static MCP supply alone does not grant a callable tool route. Only exact selected supply plus the matching active package and capability token admits the implemented `/capabilities/mcp/*` Integration family and NanoCore-owned policy; the end-user Skill's bundled CLI is not part of this path.

Dynamic supply changes create a new AEP snapshot and follow the safe-point refresh rules in the Static Supply Projection.

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

NanoCore must preserve enough rejected-record diagnostics to debug Worker Agent and Sandbox Integration failures without importing invalid records into product history.

## Sequence, Idempotency, And Replay

Every worker-emitted control record must include lineage and sequence.

Sequence numbers are monotonic within one package snapshot and channel.

NanoCore should reject stale sequence numbers, deduplicate exact retries, and return idempotency conflicts when a repeated sequence or request id carries different semantic content.

Control polling should support a cursor or delivered-sequence model so a worker can recover from transient network failures without losing pending commands.

After readiness, retry must preserve the same logical operation identity, worker sequence, and canonical payload fingerprint. Sandbox Integration retries only the AEP-resolved sandbox-local worker-control binding, pauses new command polling and new control-dependent work while disconnected, and does not create an unbounded offline outbound queue.

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

## NanoHost Deployment Independence

Every NanoHost deployment shares the same Worker-facing contract and product semantics.

Every deployment uses one configured NanoHost and the same Sandbox Integration boundary. Every active sandbox receives only sandbox-local bindings for `/worker-control/*`, `/inference/*`, and, only after separate implementation and enablement, `/capabilities/*`. Sandbox Integration carries the enabled logical route families through the sandbox's one stock RelayStream and its one standard HTTP/2 session; it never exposes a NanoCore address or remote transport endpoint to the Worker Agent. Current workers advertise no callable capability binding.

Host topology may change the native data-transfer implementation owned by `docs/specs/20260801-nanohost_workspace_data_boundary.md`. Workspace, Artifact, image, and model bytes remain outside the control HTTP/2 session.

No deployment topology gives NanoCore a second lifecycle channel or gives the sandbox a separate NanoCore control path. NanoHost lifecycle, Runtime Epoch fencing, one-session carriage, and RelayStream ownership are governed by `docs/specs/20260802-nanohost_runtime_and_transport.md`.

These differences must not leak into Worker records, public App API, end-user CLI operations, Web UI, Goal Mode, Action Center, or review semantics.

## Failure And Recovery

Before the complete route-bound worker-control readiness exchange succeeds, required control failure is fail-fast and Sandbox Integration must not launch the main Worker Agent child.

Retry remains disabled until the main Worker Agent child starts, so an interruption before launch is fail-fast. After launch, a retryable worker-control interruption enters the single bounded outage budget owned by `docs/specs/20260703-worker_control_protocol.md`. The worker-control client inside Sandbox Integration keeps the same child alive while pausing new command polling and new control-dependent work and retrying only the same AEP-resolved sandbox-local binding with the same logical operation identity; the Integration carriage itself does not retry or reinterpret the request.

NanoHost reconnect fences the predecessor NanoHost transport session before adopting traffic and must not create another worker, Sandbox, AgentSession, lease, snapshot restore, or compatibility lookup. NanoCore may re-adopt only the exact durable lease, worker incarnation, AEP snapshot, control lineage, backend session, Workspace handoff, worker-control token binding, process key, and exact next sequence proven through the scheduler and worker-control contracts.

Budget expiry, authoritative cancellation, cleanup fencing, or terminal token, lineage, sequence, policy, digest, workspace-path, or schema failure stops or cancels the worker. NanoCore should still collect transcript files already written through backend transport and import validated records as evidence.

Ordinary AgentSession termination closes only its native context, routes, mutable slots, outputs, evidence staging, and AgentSession-local binding after their owners settle. It preserves a compatible shared Sandbox and sibling AgentSessions. If exact local cleanup cannot be proved, admission stops and cleanup widens to the Harness, Sandbox, or Runtime Epoch boundary whose complete effect domain can be fenced. An accepted Sandbox create or delete whose completion cannot be proved invalidates the complete Runtime Epoch; affected AgentSessions then receive truthful independent `interrupted` or `unknown` outcomes through their owning records.

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

When exact adoption succeeds, the existing worker-Turn checkpoint, AgentSession, and Workspace synchronization records continue terminal observation, evidence collection, review, and cleanup for the same Turn. When key, lineage, sequence, or deadline verification fails, those same owners project the interrupted outcome and reconciliation path. Sandbox Integration publishes `final_status` only after sealing runtime provenance and Workspace changes, making it the last durable-output barrier. A durable accepted final status closes through the existing backend, checkpoint, Workspace, Turn, lease, and capacity records; no settlement coordinator or parallel domain workflow exists.

The reconnect contract adds no second protocol or recovery owner. Sandbox Integration, RelayStream, and the NanoHost session preserve transport confidentiality and the distinct worker-control token boundary defined by the runtime-and-transport owner. A NanoHost or Execution Server failure that cannot prove continuity yields the existing truthful `interrupted` or `unknown` outcome; it never infers completion, replacement, or settlement.

## Public Surfaces

Public App API, the end-user Agent Skill Interface, Web UI, deployment docs, and status summaries should describe:

- Core mode: `local | server`
- Worker runtime: `container`
- Runtime target: one configured NanoHost
- Container backend: stock OpenShell private to NanoHost

They should not advertise host execution as a supported Worker runtime.

The end-user `openkit` Skill's bundled CLI is the implemented channel facade over NanoCore public APIs. It uses the transport-neutral operation catalog and does not expose a second workflow or route authority.

The transport-neutral operation catalog may need operations to inspect worker runtime status, worker communication diagnostics, supply catalog summaries, capability call summaries, and staged review evidence.

It must not become worker-side MCP supply and must not expose backend-private sandbox control.

## Implementation Roadmap

Implementation should move through these release-neutral milestones:

1. Remove host Worker runtime from product selection and public surfaces.
2. Promote canonical worker schemas into `packages/worker-protocol`.
3. Keep OpenCode and Pi behind the implemented `bounded-turn` `prepare`/`collect` mode, add the accepted five-operation `session-continuity` mode to the same registry, and implement that mode first for Codex in `packages/worker-shim`.
4. Complete live candidate event append, NanoCore validation, and transcript import deduplication through Sandbox Integration's `/worker-control/*` binding.
5. Complete NanoCore-resolved Skill and MCP supply catalog materialization into container workers.
6. Extend the implemented selected-MCP capability slice only through separately accepted capability owners; Knowledge Store operations and other families remain future work and must not add another control path.
7. Keep the unified `openkit` Skill, bundled CLI, and operation catalog aligned as public runtime-communication operations land so coordinator agents can inspect and drive them through public NanoCore APIs.
8. Verify the full loop through public NanoCore APIs and the Agent Skill Interface without relying on backend-private runtime state.

## Verification Expectations

The communication model is implemented only when:

- no real product runtime path uses host execution
- every supported NanoHost deployment generates the same AEP Worker-facing control contract
- every supported NanoHost deployment uses the same Sandbox Integration, RelayStream, worker-control protocol, transcript schema, event schema, exact disabled-or-selected-MCP capability declaration, and Workspace-change schema
- NanoCore validates candidate records against canonical schemas without importing runtime-native adapters
- Runtime adapters own runtime-native argv, environment, isolated state paths, and output parsing; the shared harness has no native config-file contract
- a fourth-runtime fixture adds one authored `AgentManifest`, one adapter module plus static registry entry, and one image definition plus existing-catalog entry without modifying NanoCore product, governance, canonical protocol, or shared-harness behavior
- base-path runtime-native command construction and event parsing occur only in the corresponding adapter, specification, and tests; images and manifests declare binaries and policy but no native argv; `bounded-turn` retains no native session metadata, while `session-continuity` retains only the restricted raw handle and state inside its exact AgentSession-private adapter root until `closeSession`; the only NanoCore native-parser exception is the narrowly isolated version-pinned S33 verifier
- Skill and MCP supply comes from NanoCore-resolved catalog snapshots
- selected MCP capability routes pass their governed catalog, schema, policy, approval, usage, audit, credential, and teardown acceptance before roadmap closure; Knowledge, context, and proposal-flow routes remain unadvertised
- no App API, NanoCore route, gateway method, or Sandbox Integration interface accepts or executes caller-supplied arbitrary argv, cwd, environment, or shell input
- tests prove token, lineage, schema, sequence, idempotency, digest, workspace path, and policy validation
- tests prove pre-readiness failure launches no worker, retryable post-readiness interruption preserves the same worker within the bounded budget, exact process-key/lineage/sequence adoption creates no replacement worker or session, and budget expiry enters the existing interrupted recovery path
- e2e smoke proves one configured NanoHost can run a bounded Goal Mode Worker step, produce reviewable evidence, close the exact AgentSession-local state, and preserve the compatible shared Sandbox and healthy Runtime Epoch
- real-host fault acceptance proves the same NanoHost and Sandbox Integration contract, stock RelayStream carriage, Sandbox materialization, separately governed data transport, and fresh-empty readiness after Runtime Epoch recovery
- real Codex provenance acceptance proves the attributed remote inference path; that gate has passed on A1, while the selected MCP slice requires its separate R058 acceptance and the broader non-MCP capability plane remains partial
- Agent-Skill-driven dogfood loops prove the coordinator can inspect runtime status, run bounded steps, review evidence, and continue/refine/reject/accept without bypassing review gates

## Testing Strategy

Required local development machine verification:

- format and static checks for touched packages
- schema and contract tests for `packages/worker-protocol`, `packages/config-schema`, `packages/app-api-schemas`, and `packages/core-client`
- NanoCore unit and black-box tests for runtime selection, AEP generation, route-bound worker-control, event append, transcript import, workspace validation, and Action Center review projection
- Sandbox Integration tests for worker-control binding, exact one-route enforcement, transcript writing, redaction, bounded output, and sequence handling, plus adapter-local tests for native argv, environment isolation, and parser behavior
- Sandbox Integration and NanoCore restart tests for pre-readiness fail-fast behavior, same-operation replay, paused command polling, same-worker adoption, recovery timeout, and terminal handoff through existing checkpoint, session, and workspace records
- selected-MCP capability tests for route authentication, server listing, tool listing and calls, policy, approval, usage, audit, credential redaction, teardown, and fail-closed disabled projection; future Knowledge operations require their own checks before advertisement
- bundled CLI tests, build, and smoke against a local NanoCore development server
- a real Agent-Skill-driven Goal Mode loop through one configured NanoHost

Required real-host verification:

- run NanoCore in server mode
- run the configured NanoHost with one fresh, verified-empty Runtime Epoch
- provide each sandbox one stock RelayStream carrying one standard HTTP/2 session with the sandbox-local `/worker-control/*` and `/inference/*` bindings, while proving that `/capabilities/*` remains absent and disabled
- connect from a Skill-capable agent app through the bundled `openkit` CLI
- create or resume a real thread
- run one bounded Goal Mode step through that RuntimeTarget
- collect Action Center rows, artifacts, workspace review evidence, worker diagnostics, and capability summaries
- prove staged review rather than direct protected workspace mutation

Remote provider quota or real Codex subscription tests must remain opt-in and explicitly documented.

If an environment cannot run a check, the implementation evidence must record the exact reason and the narrowest rerun command.

## Risks And Mitigations

Risk: Removing host runtime slows local development.

Mitigation: invest in a fast local-container development profile and deterministic container tests.

Risk: The shared Integration carriage becomes a generic RPC.

Mitigation: keep `/worker-control/*` limited to the worker-control protocol, expose only the current typed interrupt command, and preserve separate tokens, scopes, payload bounds, retry rules, and failure semantics for every logical route family.

Risk: Worker-side MCP bypasses NanoCore policy.

Mitigation: advertise no `/capabilities/*` binding until NanoCore-resolved MCP catalog snapshots, gateway policy, and the thin Sandbox Integration capability client pass acceptance.

Risk: Remote recovery after NanoCore restart adopts the wrong worker or extends an outage indefinitely.

Mitigation: require the exact memory-only process key, durable lineage, next sequence, and preserved deadline; claim reconnect and apply the ordinary heartbeat update in one database transaction while timeout cleanup uses one exact-row CAS, so only one side can win; fall back to the existing interrupted-evidence path on any mismatch or timeout.

## Decisions

- Host runtime is removed from product execution and public surfaces.
- Public runtime configuration exposes one NanoHost identity and rendezvous boundary, not a worker-runtime, placement, backend, SSH, Gateway, or sandbox-direct endpoint selector.
- Sandbox Integration's sandbox-local `/worker-control/*` binding is the sole Worker-facing target for worker control. The `/inference/*` and future `/capabilities/*` families share only the standard HTTP/2 carriage and retain separate tokens, scopes, payload bounds, retry rules, failure semantics, usage, and audit ownership.
- NanoHost lifecycle, Runtime Epoch fencing, stock RelayStream carriage, standard HTTP/2 session ownership, and transport credential boundaries are owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`.
- The AEP resolves one specialized LLM route, while its runtime-native projection is adapter-specific and fail-closed. Codex `0.153.4` and OpenCode `1.18.1` can represent the trusted NanoCore relay within the current no-file contract; Pi `0.85.1` cannot and supports only an exact pinned native direct provider/model pair.
- `openkit-worker-shim` is the generic real container entrypoint; runtime-native behavior is selected by the AEP-declared opaque adapter id inside the worker image.
- Codex, OpenCode, and Pi use one shared Harness registry with the two closed adapter modes and separate runtime adapters; only an adapter that proves `session-continuity` is eligible for the shared-Harness RuntimeTarget.
- One authored `AgentManifest`, one adapter module plus static registry entry, and one governed image definition plus existing-catalog entry are the complete permitted production extension surface for a fourth Worker Agent.
- The `bounded-turn` adapter contract is only `prepare` and `collect` and retains no native session metadata. The `session-continuity` contract is exactly `openSession`, `prepareTurn`, `collectTurn`, `inspectSession`, and `closeSession`, retains one restricted handle only in its AgentSession-private root, and removes that state at exact close. Shared process-group termination owns interruption, and both modes use the 16 MiB capture and 16 KiB-per-stream diagnostic-prefix bounds.
- Selected MCP capability routes are enabled only by exact AEP supply and active Turn authority; all other capability routes remain disabled, and static supply never authorizes direct upstream execution.
- S33 Codex provenance remains a separate optional verified extension and is not part of the common adapter contract.
- Live candidate event append and NanoCore validation should be implemented before broad Skill, MCP, knowledge, and context capability work.
- Dynamic Skill and MCP updates create new AEP snapshots and refresh only at safe points when explicitly supported.
- Sandbox Integration redaction is best effort; NanoCore redaction and verification remain authoritative.
- No diagnostic command exists in the current contract; any future typed diagnostic is separately designed and cannot accept arbitrary execution input.
- Required route-bound worker control is fail-fast before readiness and bounded-reconnect after readiness; successful process-key adoption continues the same worker and existing terminal-handoff records, while verification failure or timeout follows the existing interrupted recovery path.

## Specialized Decision Index

This overview records the worker runtime communication direction. Detailed implementation decisions live in the narrower specs that own each contract:

- Worker-control live append route shape, envelope semantics, event sequence idempotency, stale/conflicting sequence handling, and response fields are owned by `docs/specs/20260703-worker_control_protocol.md`.
- Runtime-internal sub-agent raw capture, parent-child provenance, trusted worker-inference identity, and runtime cache lineage are owned by `docs/specs/20260711-worker_runtime_subagent_provenance.md`.
- Worker capability route projection, canonical `knowledge.*` target families, sandbox bearer lineage, `WorkerCapabilityCallSummary`, metering, and audit hooks are owned by `docs/specs/20260703-worker_agent_capability.md` and `docs/specs/20260702-knowledge_store_governance_rules.md`.
- Worker-side Skill and MCP catalog resolution, approved catalog ids, version or digest resolution, runtime-adapter compatibility, and provider and Vault references are owned by `docs/specs/20260703-agent_manifest_aep_resolution.md`, `docs/specs/20260703-worker_agent_capability.md`, and `docs/specs/20260704-worker_mcp_tool_supply.md`; the AEP carries only their resolved static supply projection, while adapter-specific native argv, safe environment, state-root use, and output parsing are owned by S64-S66 and their future peer specifications.
- Filesystem workspace staging, resolved-path containment, symlink escape rejection, staged review, apply, and recovery behavior are owned by `docs/specs/20260703-workspace_synchronization.md`.
- End-user coordinator diagnostics must use public NanoCore App API surfaces rather than runtime internals. Concrete Skill guidance and CLI operations are owned by `docs/specs/20260713-openkit_agent_skill_interface.md`.
- NanoHost lifecycle, Runtime Epoch fencing, Sandbox Integration carriage, stock RelayStream ownership, and route-family isolation are owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`; OpenShell network policy defaults, Codex binary allowlists, Git remote helper binary allowlists, and native data transfer remain with their narrower execution-environment and workspace owners.
- Restart effects use ordinary worker-control adoption plus the existing workspace synchronization, evidence-import, and bounded-step owners; no separate recovery workflows or coordinators exist. Detailed rules are owned by `docs/specs/20260703-worker_control_protocol.md`, `docs/specs/20260703-workspace_synchronization.md`, `docs/specs/20260703-audit_usage_evidence_records.md`, and `docs/specs/20260703-runtime_scheduling_scale.md`.

## Related Documents

- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260713-openkit_agent_skill_interface.md`
- `docs/specs/20260703-workspace_synchronization.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
- `docs/specs/20260703-runtime_scheduling_scale.md`
