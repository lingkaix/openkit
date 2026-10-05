---
status: Accepted
implementation: Partial
kind: boundary
updated: "2026-10-02"
---
# Worker Runtime Communication Model

## Retained Files And Adapter Closure

[Persistent Worker Volumes](20260910-persistent_worker_volumes.md) owns opaque data retention across environment replacement. Adapter close releases active native-handle authority and proves writer absence; it no longer removes retained native data. Per-Turn transport and control cleanup remains separate from retained native data. This changes filesystem lifetime, not the normalization and acceptance boundary. The accepted design replaces the five-operation per-Turn launch contract and bounded-turn result parsing with one resident adapter contract.

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

Rejection is truthful and terminal for that candidate. NanoCore MUST NOT repair, coerce, partially accept, or infer a corrected shape, and a rejected candidate MUST NOT be retried into acceptance by resubmission under a different shape. A proved ordinary file-submission refusal is a separate command failure: a corrected new request may capture a new file during the same active Turn without reinterpreting the rejected candidate.

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
- NanoHost identity or transport, Runtime Epoch lifecycle, OpenShell supervision, RelayStream feasibility, or route-family wire schemas. The loopback credential lifecycle belongs to [Worker Agent Capability](20260703-worker_agent_capability.md).

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
- Preserve an already launched worker through a transport loss or a NanoCore restart, and exact end-to-end worker-control reconnect, without creating an alternate control path, replacement worker, replacement sandbox, or replacement session. A binding that cannot be proved exactly is closed or fenced, and a successor resumes natively.
- Move runtime-native command construction, output parsing, isolated state-root selection, and lightweight transcript normalization into worker-side packages.
- Keep NanoCore focused on policy resolution, Agent Environment Package snapshot creation, canonical record verification, durable state, Action Center, evidence, and review gates.
- Preserve backend portability for OpenShell first and later Docker, VM, Kubernetes, managed sandbox, or custom worker runtimes.
- Prepare the design for controlled NanoCore-managed Skill, MCP, Knowledge Store, context, and tool supply without allowing Worker Agents to modify NanoCore-managed supply authority.
- Keep all worker-produced repository changes behind NanoCore-owned staged review and apply gates.
- Prove a stable runtime extension boundary for Codex, OpenCode, Pi, and DeepSeek so a further Worker Agent adds only one authored `AgentManifest`, one worker-side adapter module plus its static registry entry, inside the one multi-runtime Sandbox image. `worker-common` remains the public base. A new runtime does not add a deployment leaf image.

## Primary Extensibility Criterion

> The real outcome is not three adapters. A further Worker Agent must require only one authored `AgentManifest`, one worker-side adapter module plus its static registry entry, inside the one multi-runtime image. Opaque runtime ids remain. NanoCore gains no runtime-name branch, command builder, native output parser, or image-selection branch for that addition. Lifecycle and Gateway amendments this change already accepted are not a failure of that boundary.

Runtime ids are opaque to NanoCore. A new runtime must not require a NanoCore enum member, runtime-name branch, command builder, native output parser, provider special case, image-selection branch, canonical schema variant, or governance rule.

The fourth-runtime test is architectural acceptance, not a later optimization. If a new adapter requires a NanoCore product or governance edit, this boundary has failed even when the worker can execute successfully.

The registry and image-catalog entries are static bookkeeping in existing owners. Dynamic adapter discovery, package loading, or a plugin framework is neither required nor permitted by this criterion.

## Non-goals

- Do not keep a host fallback for real Worker execution.
- Do not expose host execution through product config, the end-user remote MCP interface, Web UI, deployment docs, capability flags, or status summaries.
- Do not make OpenShell policy YAML, sandbox ids, gateway internals, raw environment variables, process handles, or provider secrets public OpenKit protocol.
- Do not let a Worker Agent add or replace NanoCore-managed supply or obtain external authority from arbitrary sources. Worker-owned tools and MCP configuration inside the admitted Sandbox are unrestricted by OpenKit; storage and network containment still apply. External traffic follows [Sandbox](../core/sandbox.md) and [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md): Gateway-required integrations remain mediated, while admitted public non-LLM grants and separately authorized non-LLM REST grants retain their respective network and credential contracts. Neither direct route creates NanoCore-managed MCP supply or an upward control route. Approval and audit apply to external systems reached through the Gateway.
- Do not let a Worker Agent write long-term knowledge, notes, or Knowledge Store records directly.
- Do not make Sandbox Integration a second NanoCore, a product state owner, a review decision engine, or a generic shell daemon.
- Do not mix the end-user remote MCP interface with worker-side MCP capability supply.
- Platform-managed external hosting calls use selected Gateway MCP and its current authorization, configured per-tool approval and audit. Local Git is worker-local work. Native Git push may be explicitly admitted user-space configuration; other external effects retain their own owners.
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

Host execution may exist only as deterministic test doubles, fixture executors, or in-process harnesses that cannot be selected through product configuration, the end-user remote MCP interface, Web UI, deployment docs, status summaries, or public capability flags.

## Worker-Facing Contract

Every real Worker Agent sees the same contract inside its container:

```text
/openkit/sessions/<agent-session-id>/config/package.json
/openkit/session/events.jsonl
/openkit/session/items.jsonl
<AEP-resolved sandbox-local /worker-control/* Integration binding>
<AEP-resolved sandbox-local /inference/* Integration binding>
<AEP-resolved sandbox-local /capabilities/* Integration binding when enabled>
declared workspace roots
declared output roots
```

The Worker Agent should not know whether the container is local or remote.

The Worker Agent should not know raw NanoCore host paths, raw remote gateway URLs, raw OpenShell gateway internals, raw backend upload/download handles, raw secrets, or private data-root paths.

The Worker Agent receives an Agent Environment Package snapshot, local files generated from that snapshot, non-secret sandbox-local route bindings and token references, declared workspace roots, and declared output roots. It never receives a NanoHost credential, raw route token, remote NanoCore or Gateway address, SSH target, Gateway forward, Runtime Epoch identity, upstream MCP topology, or direct sandbox-to-NanoCore endpoint. Every worker AEP enables exactly the three governed MCP operations through `/capabilities/*`, because its resolved MCP supply always includes the built-in servers that [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md) supplies without manifest selection; an empty manifest MCP selection does not disable the capability plane.

## Communication Planes

### Static Supply Projection

NanoCore resolves agent setup into an Agent Environment Package snapshot before launch.

Static supply is a pre-launch setup projection, not an additional communication plane.

The AEP snapshot carries lineage, selected runtime, workspace inputs, generated files, Skill refs, worker-safe selected MCP supply refs, a preferred logical-model ID, an exact allowed logical-model set, non-secret local Integration bindings and token references, an exact capability declaration, policy summaries, and backend capability requirements. Every admitted worker AEP enables exactly `mcp.list_servers`, `mcp.list_tools`, and `mcp.call_tool` for its resolved MCP supply, which includes the built-ins independently of manifest selection. Every worker inference request names one member of the immutable model set; NanoCore validates membership at the worker inference boundary before Gateway dispatch. A missing or disallowed logical model returns the typed `worker_logical_model_not_allowed` failure without Provider effects, and neither Sandbox Integration nor the runtime adapter sees or selects a concrete route.

The backend materializes the AEP snapshot into the container.

The selected worker adapter configures a resident first-party host from resolved AEP inputs, including admitted public native environment values, and derives only protected environment bindings. Argv launch of a one-shot CLI is not the target for Codex, Pi, or OpenCode. Pi discovery follows [Pi Worker Adapter](20260716-pi_worker_adapter.md); the rationale is recorded in [Pi Native MCP Discovery](../decisions/20260930-pi_native_mcp_discovery.md). Each adapter must prove that its pinned runtime can represent the logical-model IDs, local inference endpoint, credential placeholder, and wire protocol without receiving Provider identity. An unsupported runtime or logical-model-catalog pairing fails closed before the host is admitted rather than being normalized, inferred, or replaced.

The adapter contract has no adapter-returned config-artifact field. There is one downward standard, the common runtime contract, carried as the Harness operations `session.open`, `session.inspect`, `turn.start`, `turn.interrupt`, `session.close`, and `harness.drain` owned by [Worker Control Protocol](20260703-worker_control_protocol.md). The resident adapter contract is the sole supported path; it has no per-Turn native-launch alternative. The shared Harness materializes only runtime-neutral AEP files and rejects any attempt to introduce adapter-authored files through a launch plan. One adapter receives a private AgentSession control binding plus fresh Turn-local output slots. Native continuation authority is valid until `session.close` and is resumed by a successor. Per-Turn credential slots in the native environment are not part of the contract. Runtime-owned data lives separately in the admitted retained volume and survives close. Any generated file that contains a credential value stays forbidden. These limits grant no config-artifact field or shared native schema and do not let retained configuration override protected current launch bindings. Native defaults and retained placement follow [Persistent Worker Volumes](20260910-persistent_worker_volumes.md#native-defaults-and-private-home-placement), with per-pin loading and precedence owned by the selected adapter. Any additional generated native setup requires an amendment rather than an unowned Harness file envelope. For NanoCore-managed MCP supply, upstream MCP commands, endpoints, credential references, and upstream credentials always remain absent from the worker; worker-owned in-Sandbox configuration and independently admitted public endpoints follow their own owners. For every admitted worker AgentSession, the native host receives that family's session loopback credential and the fixed loopback server URLs, and it does not receive the upstream capability token. Mint and delivery of that credential belong to [Worker Agent Capability](20260703-worker_agent_capability.md).

Worker inference uses only the trusted logical Gateway relay. Mint and delivery of the session loopback credentials belong to [Worker Agent Capability](20260703-worker_agent_capability.md). The native host does not receive the upstream per-Turn inference token, concrete Provider credentials, Provider endpoints, account identities, or direct Provider egress. Direct-provider worker inference is not part of this target. Separately declared non-LLM tool and service egress remains ordinary AEP Sandbox policy: an exact grant may authorize only its declared endpoint and executable-and-descendant scope under [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md#manifest-shape) and does not become Provider authority or an inference-relay exception. Declared runtime-env credentials are session-static inside the resident binding, as [Worker Credential Access Declarations](20260709-worker_credential_access_declarations.md) states.

Dynamic supply changes create a new AEP snapshot.

NanoCore may deliver a safe-point supply refresh command only when the resolved AEP explicitly declares refresh support proved by the selected image and Sandbox Integration.

Each adapter declares whether its runtime lists tools again at Turn start, and its slice establishes the answer by probe; this specification does not invent that answer. If the adapter declares that the runtime lists tools again at Turn start, the next Turn on the same binding sees the new supply. If the adapter declares that it does not, or the declaration is absent or uncertain, the current Turn settles and a successor AgentSession resumes the native conversation with the new supply. Narrowing and revocation still apply at the next call. A supply change is never visible mid-Turn.

### Control Plane

The control plane uses `openkit-worker-control-v2` end to end.

The worker-visible endpoint is the AEP-resolved sandbox-local `/worker-control/*` Integration binding. Sandbox Integration is the outer adapter, not a capability gateway or Core participant. Its outer carriage adapter carries the unchanged protocol through one standard HTTP/2 session inside one stock OpenShell RelayStream; it does not authorize, inspect, retry, reorder, or reinterpret worker-control messages. The worker-control client inside Sandbox Integration applies only the retry semantics owned by the worker-control protocol.

The control plane is for session lifecycle and small control messages only.

It must not become a generic capability RPC, arbitrary shell, file transfer channel, or product-state mutation API.

Current worker-control families are:

- heartbeat
- artifact notice
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

Workers intentionally submit one finished file through `work_submit_artifact` on the existing built-in work MCP supply. The command contains a request id, the existing Artifact kind, non-empty title, one canonical absolute POSIX path, exact media type `text/markdown`, `text/plain`, or `application/json`, and at most one `materialProposal` tuple `{ materialId, baseRevisionId, baseContentDigest }`. Core derives the producing package and Turn, physical target, admitted output slot, relative path, capture request identity, and byte bound from authenticated context. The path must be a strict child of exactly one AEP output root with `registerAsArtifacts=true` and `retention=sync-on-turn-end`; path equality, traversal, non-canonical spelling, ambiguous overlapping roots, and every undeclared root fail closed before canonical writes. Separate requests may intentionally capture the same path again. Artifact notices remain bounded diagnostics, and agent-authored transcript declarations no longer produce Artifacts. The synchronous submission replaces that path without a compatibility reader or pending declaration record. The engineer's decision is recorded in [Synchronous Submission Of Worker Files](../decisions/20261005-worker_file_synchronous_submission.md).

Each call captures one file through the existing `file.export` effect during the active Turn, without terminal inspection or invented terminal proof. The agent finishes writing before submission. Success guarantees the exact verified exported copy captured during that call, not a filesystem snapshot, invocation-time contents, or native correctness. Later file edits and later Turn failure or cancellation leave a committed Artifact immutable and visible under its original audience. NanoCore admits only non-empty well-formed UTF-8, parses declared JSON, and performs no newline or Unicode normalization. Before any Artifact, reference Item, or Review write, it checks the transport digest and length, format, producing lineage, Material proposal against exact accepted Context selections, and every submitted byte against the exact injected-value evidence below. An exact injected-value match in the submission request id is likewise refused before canonical writes because origin and receipt retain that key verbatim; the key is not redacted or replaced. A rejection publishes nothing for that call; earlier committed calls remain published.

The current per-Turn limit is 16 MiB of successfully published Worker Artifact bytes, derived from exact-Turn canonical Artifacts. Each backend-owned copy and its actual reader, staging, and result admission are bounded to remaining publication capacity plus one sentinel byte. A larger copy is rejected immediately without downloading the unbounded file. Rejected calls consume no publication capacity, and a corrected new request can transfer again; attempted transfer bytes across the Turn may exceed 16 MiB plus one. Final quota checking and publication are serialized under existing authority, with no durable counter or reservation. No SQLite transaction remains open while awaiting capture.

Artifact identity derives from authenticated producing package, Turn, and submission request id, with no server ordinal or transcript sequence. Exact request and path/metadata replay the complete original Artifact, reference Item, Review, and receipt before another export; changed input conflicts. A corrected file or new captured version uses a new request. Core rechecks current authorization and active admission after capture and synchronously commits publication before terminalization can win; a sealed Turn admits no new publication. Late Host results cannot publish after admission is lost. A complete authority tuple without its command receipt, or any partial or contradictory tuple, returns `recovery_required` without receipt reconstruction or effect repetition under [Work Resource Interaction Model](20260713-work_resource_interaction_model.md#artifact-and-item-lineage). Lost capture remains unknown; only the existing authorized successor rule may deliver an exact retained result. There is no pending declaration, upload queue, automatic recapture, or second settlement lifecycle. Submission does not accept Task or Goal completion.

The shared comparison rule for worker-output Artifact payloads and [transcript Item admission](20260703-worker_control_protocol.md#exact-value-protection-at-transcript-item-admission) covers every exact non-empty sensitive value injected into that worker materialization, including runtime environment, runtime file, direct-provider, worker-control, and trusted-relay values. The literal comparison set contains the UTF-8 bytes of each complete injected value, deduplicated by byte equality; a runtime-file entry contributes its complete content, and a match means contiguous byte-substring containment anywhere in the payload rather than whole-payload equality. Secret environment, file, and provider values remain backend-private process memory until collection or cleanup; the existing durable scheduler-owned sandbox binding reference is included without creating another record or copy. The assembled comparison evidence MUST NOT enter a package, transcript, Artifact, diagnostic, log, new durable record, or response.

Across a NanoCore restart, runtime-env values are re-resolved at the exact Vault material version recorded by the binding's injection evidence. The three original lease-bound worker-control, inference, and capability route-token hashes also establish exact comparison evidence without recovering or persisting plaintext: NanoCore MUST scan every 43-byte window, including within a longer alphabet run, accept a candidate only if it is the canonical unpadded base64url spelling of exactly 32 decoded bytes, and compare SHA-256 of those decoded bytes with each original route hash. Canonical spelling requires re-encoding the decoded bytes to equal the candidate exactly; an alternative spelling that decodes to the same bytes MUST NOT match. The two required session loopback digests remain a separate hash domain: [Snapshot Chain](20260703-workspace_synchronization.md#snapshot-chain) defines their windowed comparison over the 43 encoded UTF-8 credential bytes, not the decoded bytes. Both kinds of window match are exact-value matches under the respective Artifact rejection and Item replacement owners, not a credential-pattern heuristic.

Comparison evidence MUST be complete and bound to the original materialization, lease, and session under their existing owners; serving-authority expiry alone does not invalidate that original comparison association. After the permitted exact-version and hash-based reconstruction, genuinely unavailable or contradictory required evidence returns `recovery_required` with product-safe diagnostics, zero Artifact or Review writes, no current-value substitution, and no skipped check; transcript Item writes follow their admission owner. Missing or stale original associations cannot be inferred from a current binding. That rejection does not refuse an otherwise provable live-binding adoption before collection is required. For unavailable or contradictory required comparison evidence, the existing backend cleanup lifecycle runs for terminal collection and live submission alike, owned by [Durable Scheduler Design](20260703-durable_scheduler_design.md#lease-reconnect-and-cleanup). Only a proved ordinary live submission refusal creates no Artifact authority and does not alone terminate a healthy Turn; containment uncertainty, lost capture, or unproved cleanup retains the existing effect and cleanup fences. This comparison rule adds no durable state, plaintext persistence, automatic retry, update lifecycle, or termination lifecycle. As with workspace publication, this exact-value check is not generic DLP and does not detect encoded, transformed, derived, or otherwise non-literal secret material.

### Capability Plane

The capability plane gives Worker Agents governed access to privileged services through the separately authenticated sandbox-local `/capabilities/*` Integration family when that family is enabled.

The accepted outer transport namespace is `/capabilities/*`. The AEP projection enables exactly `mcp.list_servers`, `mcp.list_tools`, and `mcp.call_tool` for every worker package, whose resolved MCP supply always includes the built-in servers; an empty manifest MCP selection does not produce `capabilities.mode: disabled`.

The implemented capability family is the selected worker-side MCP slice. Future families include Knowledge Store search, Knowledge Store read, context retrieval, external API calls, network proxy access, and other non-LLM tools.

NanoCore owns routing, policy checks, credential references, redaction, metering, audit summaries, and upstream error normalization.

Worker Agents must not access NanoCore internals, SQLite files, raw data roots, raw secrets, upstream MCP topology, or arbitrary network sources to obtain capabilities. Selected MCP calls use only the fixed authenticated loopback Integration projection and NanoCore Gateway; all undeclared capability routes remain non-callable.

Every Worker Agent runtime that expects an OpenAI-style base URL receives the sandbox-local `/inference/*` Integration binding from its AEP. The inference token, model and provider scope, bounds, failure semantics, usage, and audit remain independent from worker control and capabilities.

The target binding has one fixed native projection: `http://127.0.0.1:17892/inference/v1`. Sandbox Integration owns that loopback-only HTTP/1 listener separately from the stock Supervisor bridge at `127.0.0.1:17891`. Only after its outer HTTP/2 session is ready may the native listener admit requests, and those accept only authenticated `POST /inference/*` and forward them through that session without changing the path, body, content encoding, or response bytes, and without changing end-to-end headers other than authentication. Authentication translation is owned by [Worker Agent Capability](20260703-worker_agent_capability.md). The local request aggregate is at most 16 MiB; carriage retains the 2 MiB family in-flight ceiling and 64 KiB maximum write owned by the NanoHost transport specification. Response bodies, including SSE, remain streaming with backpressure and cancellation rather than receiving a new aggregate buffer or retry. Worker-control, capability, absolute-form, unauthenticated, and non-`POST` requests are rejected locally before an outer stream opens. The native projection creates no second bridge, NanoHost route, egress grant, DNS name, AEP-selected URL, provider authority, durable state, or retry owner.

The AEP-resolved logical-model relay and token reference are specialized for inference and must not be reused for control, knowledge, MCP, vault, or generic capability traffic.

Inference is a specialization of the Capability plane, not an additional communication plane.

The selected MCP plane reuses the existing server-side policy, CapabilityCall ledger, usage, audit, and Vault owners while retaining its separate worker-facing wire contract; future capability families require their own accepted owner and implementation slice.

### Audit And Evidence Cross-Cutting Projection

Audit and evidence are cross-cutting projections over the four communication planes, not additional planes. They record what was launched, what policy was applied, what the backend did, what the worker reported, what changed, and what a human reviewed.

Sandbox Integration may produce normalized audit events and transcript records.

The backend may collect backend-native logs and transport evidence.

NanoCore verifies and stores product-safe summaries and evidence references.

Public App API, end-user remote MCP interface, and Web UI surfaces expose OpenKit ids, summaries, digests, artifact ids, review ids, and next suggested actions rather than backend-private internals.

## Sandbox Integration

Every real worker container runs Sandbox Integration, whose current implementation seed is the generic `openkit-worker-shim` entrypoint plus its runtime adapter. The removed runtime-specific and sidecar entrypoints are not part of the target architecture.

Sandbox Integration owns only outer transport adaptation, injection of already-resolved local bindings, and runtime-neutral worker lifecycle behavior inside the image. It is the link with NanoHost and NanoCore and the supervisor. A selected runtime adapter owns native translation. NanoCore owns canonical verification outside the image and remains the control plane. Sandbox Integration is not a capability gateway, scheduler, policy owner, provider selector, usage owner, audit owner, or second Core. "Harness" names only the in-Sandbox worker-shim component.

Sandbox Integration should:

- read the AEP snapshot and generated files
- materialize runtime-neutral AEP files and inert MCP supply metadata without enabling executable MCP connectivity
- allocate one private control binding per open AgentSession until `session.close`, allocate fresh disposable Turn-local output slots there, and address native working data separately in the admitted retained volume. Mint and destruction of the session loopback credentials belong to [Worker Agent Capability](20260703-worker_agent_capability.md). Turn route tokens are not placed in the native environment
- require one preferred logical model and one exact allowed logical-model set and pass only those IDs, the Gateway token placeholder, the sandbox-local worker-control binding, and the sandbox-local inference binding to the selected adapter without translating them into a Provider-native schema
- supervise a resident runtime host. Integration and the Harness do not launch a new native process for every Turn. Plugins, Extensions, and tool execution stay out of the long-lived Integration process
- capture at most 16 MiB of ordinary native stdout for resident observation and fail closed on overflow; the optional S33 Codex provenance sink streams separately under S33's own declared aggregate bound and is not double-buffered here
- retain at most a 16 KiB diagnostic prefix from each ordinary stdout and stderr stream
- convert adapter-normalized results into schema-conformant candidate OpenKit transcript and event records
- write `/openkit/session/events.jsonl` and `/openkit/session/items.jsonl`; Artifact submission uses the existing work MCP supply rather than a transcript declaration writer
- emit heartbeat and artifact notices through the route-bound `/worker-control/*` family exposed by Sandbox Integration
- append schema-conformant candidate events through the route-bound `/worker-control/*` family exposed by Sandbox Integration
- leave workspace-change capture to the outside read-only scan. Sandbox Integration does not publish workspace changes at native exit. The next Turn is dispatched after Turn-end collection completes. A change set whose `base` differs from the previous `head` is `recovery_required` at ingestion. The change-set schema and the first link's base are owned by [Workspace Synchronization](20260703-workspace_synchronization.md). A work volume's chain starts from Core's accepted base for that work slot, and collection returns `recovery_required` when that base is unknown
- The workspace blob credential check runs in the NanoHost scan, as [Snapshot Chain](20260703-workspace_synchronization.md#snapshot-chain) defines, where a loopback credential is compared by digest and the other credential values keep this model's literal contiguous-substring rule, any match fails closed with the value in no patch, manifest, or transcript, and the check is not generic DLP
- maintain sequence numbers and lineage on emitted records
- apply best-effort lightweight redaction before records leave the container
- fail before child launch when required route-bound worker-control readiness has not completed
- after readiness, keep the resident host's control path inside the worker-control protocol's bounded retryable outage budget. Budget expiry fails the affected Turn. It does not kill a shared host or sibling bindings. Dedicated-host death ends that binding. Transcript evidence already written is retained. The control-plane budget and zero inference availability during a NanoCore outage stay as the control protocol states them

The shared Harness must not understand a Codex, OpenCode, Pi, DeepSeek, or future runtime event type. It accepts only adapter-owned continuity proof and an adapter-normalized result. One Harness may hold multiple AgentSession bindings for distinct Threads and may supervise one shared server that hosts many bindings, or one dedicated host per binding. This change keeps one active Turn per Harness. Concurrent Turns across bindings stay accepted in [Runtime Scheduling And Scale](20260703-runtime_scheduling_scale.md) and unimplemented. Process identity is private execution state and never substitutes for AgentSession identity or native-conversation proof. One Thread has at most one resident current AgentSession binding.

The worker-side adapter registry has one resident contract. The adapter implements only the six Harness operations. `session.open` carries `resume: { locator, digest } | null`. A new binding may return pending only when the pinned native protocol creates its conversation with the first prompt, or when the accepted adapter owner explicitly defers native creation until resolved setup and route authority available with the first Turn. Pending is not permission for native work requiring an active Turn, and it is never a fallback for failed resume. The first successful Turn and subsequent exact inspection must establish one restricted ready handle before the binding becomes reusable. A later Turn submits on the resident binding. A successor resumes the retained reference. `turn.interrupt` reports the actual cancellation outcome and does not close the AgentSession. Its purpose is `interrupt`. Human requests follow pending-request semantics, not interrupt mappings. No free-text inference is allowed. Process-group kill of a resident shared server is not the cancel proof. An adapter is supported only when its accepted owner and selected image prove a resident context across Turns, exact native resume, inspection, session-local state isolation, and close that preserves resumable context. A runtime that cannot do those is an unsupported capability. Native resume failure is explicit. A residual native permission request receives the pinned runtime's shortest-lived allow by default without interrupting the Turn, a user's explicit native deny rule stays, and each adapter owner maps this onto its native permission surface ([decision](../decisions/20261001-sandbox_full_capability_rulings.md)). Steering, follow-up, arbitrary adapter operations, and capability inference remain absent. Refusal with no Turn bound, the Turn-barrier drain, and destruction at `session.close` belong to [Worker Agent Capability](20260703-worker_agent_capability.md). A sibling binding's credential is refused. Collection does not wait for process-group absence.

The private resident Turn settlement promise resolves with an adapter-normalized result only when the adapter has proved that the addressed native work ended. Ordinary native failure is a resolved failed result, not an exception. When acceptance or settlement cannot be proved and live native work cannot be excluded, the adapter retains a private Turn attempt for cleanup and rejects its settlement promise instead of returning a clean start refusal or a fabricated terminal result. The Harness then requests bounded interruption. Interruption fulfillment proves that the addressed native work stopped; rejection or expiry keeps cleanup unknown, retains capacity and Thread ownership, and invokes the existing cleanup fence. A later successful stop may establish cleanup even though the original settlement promise remains rejected. Returning the cleanup attempt supplies no additional execution authority and does not establish successful native completion.

Codex-native provenance capture remains an optional adapter-local implementation connected to the separately owned and verified S33 provenance boundary. It is not a shared adapter operation and creates no provenance requirement for OpenCode, Pi, or a fourth runtime.

Candidate worker records become canonical product truth only after NanoCore validates their lineage, sequence, schema, policy, digest, and workspace boundaries and commits them through the owning product records.

Sandbox Integration must not:

- own Workspace, Thread, Turn, Item, Goal Mode, Action Center, Knowledge Store, Review, or Apply state
- make final authorization decisions
- bypass NanoCore policy checks
- install arbitrary Skills, MCP servers, tools, packages, or credentials. An in-Sandbox MCP server or tool that the Sandbox configuration provides is unrestricted Sandbox execution; storage and network containment still apply at the Sandbox boundary, and approval and audit apply to external systems reached through the Gateway. External traffic follows [Sandbox](../core/sandbox.md) and [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md): Gateway-required integrations remain mediated, while admitted public non-LLM grants and separately authorized non-LLM REST grants retain their respective network and credential contracts. Neither direct route creates NanoCore-managed MCP supply or an upward control route. These routes grant no installation authority to Sandbox Integration
- read NanoCore private storage directly
- push, publish, tag, deploy, or trigger external side effects without a NanoCore-approved path
- become a generic interactive shell

Sandbox Integration redaction is best effort.

The workspace publication guard is exact-value protection only. It does not provide generic DLP or detect encoded, transformed, derived, or otherwise non-literal credential material.

NanoCore canonical verification and redaction remain the server-owned product boundary; [Relationship To Items](20260703-worker_control_protocol.md#exact-value-protection-at-transcript-item-admission) owns exact-value replacement at worker transcript Item admission.

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

One multi-runtime image replaces the three single-runtime deployment leaves. `worker-common` remains the public base. The image contains Codex, Pi, OpenCode V2, and DeepSeek, and the runtime is chosen per AgentSession. The image catalog and the image id are owned by the worker execution environment images specification. Images may share build mechanisms. The deployment image installs the four native runtimes, the generic worker shim, the statically registered adapter modules, and the declared smoke checks.

The three concrete adapter contracts are owned by:

- `docs/specs/20260716-codex_worker_adapter.md`
- `docs/specs/20260716-opencode_worker_adapter.md`
- `docs/specs/20260716-pi_worker_adapter.md`

## Current Implementation Projection

NanoCore implements Artifact and Review exact-value rejection and transcript Item replacement through one shared byte matcher, requiring complete original-materialization evidence and exact-version restart reconstruction before canonical admission. Synchronous file submission replaces closeout declaration publication under the accepted submission contract above.

The current implementation is a partial projection of this broader communication model. The facts in this subsection describe code and completed local evidence only; they do not replace the owning acceptance predicates or refreshed real-host proof:

- `packages/worker-protocol` exists and defines canonical worker lineage, schema version, worker event records, transcript records, workspace change manifests, capability call summaries, worker-control request and response envelopes, and worker error shapes.
- `packages/worker-shim` provides one generic zero-argument `openkit-worker-shim` entrypoint, one static registry, and the one resident adapter contract: `openSession` returns a binding that starts Turns, reports its native handle and host liveness, and closes. Its shared Harness admits independent AgentSessions for distinct Threads, runs the six private operations, and runs at most one active Turn. `session.open` registers the two session loopback credentials, opens the resident binding with the session-static runtime environment, and resumes from the reference stored under the carried locator when its digest matches. A binding takes another Turn when its handle was ready at open or one of its Turns completed. The per-Turn launch contract, both adapter modes, and the durable command poll are deleted, and the production registry is empty until the resident Codex, Pi, OpenCode, and DeepSeek adapters land. The shared shim has no native config-artifact contract, generic capability client, sidecar binary, or runtime-name fallback.
- The resident adapter interface and generic Harness are implemented, and the production adapter registry registers the resident `codex`, `deepseek`, `opencode`, and `pi` adapters. Earlier Codex, Pi, OpenCode, image-smoke, and A1 results describe the removed implementation, not this candidate. Resident adapter, image-smoke, and exact-candidate runtime acceptance remain pending in their assigned slices.
- NanoCore preserves the strict manifest-authored image, pull policy, runtime binaries, adapter id, logical-model admission, and Sandbox envelope through `ResolvedAgentSetup`, then projects the preferred and exact allowed logical-model IDs into the immutable AEP. `control.adapter.targetRuntime` alone selects the adapter; runtime kind, image name, environment, deployment, transport, and backend topology do not select or infer one.
- The zero-argument Harness keeps one Integration client alive inside the bounded outage budget and may hold multiple resident AgentSession bindings; the production binary has no package-argument or one-shot compatibility path.
- `apps/nanocore/src/runtime/agent-environment.ts` resolves OpenShell-backed AEP snapshots with the fixed sandbox-local Integration control binding and exact `worker-control` backend capability requirements. Current packages enable only the three selected MCP routes when MCP supply is non-empty and otherwise emit a disabled capability plane with no routes.
- `apps/nanocore/src/runtime/worker-control-gateway.ts`, `worker-control-records.ts`, `worker-control-sequences.ts`, `worker-control-rejected-evidence.ts`, and `worker-control-rebuild.ts` provide version-2 control envelopes, rejection evidence, and restart rebuilding for registered AEP snapshots; canonical worker records retain version 1. No worker command state exists.
- `apps/nanocore/src/app.ts` exposes current worker-control routes for heartbeat, artifact notice, event append, final status, supply-refresh acknowledgement, and capability-call summary.
- NanoCore exposes the private exact server-list route and per-selected-server MCP Streamable HTTP route under `/api/worker-capabilities/mcp/*`; its MCP Gateway owns bounded stdio and HTTP upstreams, schema snapshots, policy, approval, Vault resolution, usage, audit, health, and teardown. `WorkerCapabilityCallSummary` remains the bounded transcript/import projection of durable call state rather than route authority.
- `apps/nanocore/src/runtime/turn-executor-factory.ts` selects only the configured NanoHost RuntimeTarget, reuses one compatible Sandbox and Harness across independent AgentSessions, opens each binding with the Thread's resume pair and fresh loopback credentials, keeps a binding open across Turns when terminal inspection proves it reusable, materializes fresh Turn package and Context inputs, and contains no alternate runtime selector fields. It carries the adapter id opaquely; the Harness registry refuses an unknown one.
- The public Worker runtime model selects only container execution through NanoHost; alternate lifecycle and endpoint selectors are absent.
- `apps/nanocore/src/runtime/worker-governance-backend.ts` owns the backend contract, canonical AEP import bytes, staged-export validation, policy projection, and eligible output-path validation reused by synchronous Artifact submission.
- `apps/nanocore/src/runtime/filesystem-workspace-sync.ts` and related storage code implement filesystem snapshot, staging, review, and apply records that are now owned by the workspace synchronization spec.

The control route, data collection, runtime-adapter boundary, inference-route validation, selected MCP capability plane, evidence, and audit foundations are implemented. Static Skill metadata grants no callable route, while selected MCP supply enables only its three governed operations. The trusted worker-inference and runtime-provenance extension remains governed by `docs/specs/20260711-worker_runtime_subagent_provenance.md`.

NanoHost, Runtime Epoch ownership, Sandbox Integration, stock RelayStream, standard HTTP/2 carriage, private Harness control, and the three outer sandbox-local route families are implemented. The fixed native HTTP/1 projection at `127.0.0.1:17892` carries authenticated inference and enabled selected-MCP requests through distinct tokens and bounds. R058 release closure still requires its own final packaged and deterministic story evidence.

## Skill And MCP Supply

This section is the contract for NanoCore-managed Skill and MCP supply and its external Gateway projection. Worker-owned in-Sandbox tools and MCP configuration are excluded from the materialization and discovery prohibitions below. That exclusion does not grant an unrestricted external download or egress, and it does not permit modifying NanoCore-managed authority. Storage and network containment stay at the Sandbox boundary. NanoCore-managed MCP supply and the upward direction stay on NanoCore-served MCP through the Gateway. External traffic follows [Sandbox](../core/sandbox.md) and [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md): Gateway-required integrations remain mediated, while admitted public non-LLM grants and separately authorized non-LLM REST grants retain their respective network and credential contracts. Neither direct route creates NanoCore-managed MCP supply or an upward control route. Approval and audit of Gateway-mediated external interaction remain required.

Skills and MCP servers in this NanoCore-managed supply are controlled by NanoCore.

Worker Agents must not discover or install that NanoCore-managed supply from arbitrary sources at runtime.

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

Sandbox Integration may write runtime-neutral Skill files and inert MCP supply metadata from that resolved supply. Admitted public native environment values are AEP inputs under [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md). The selected adapter may derive runtime-native argv, fixed loopback bindings, only protected environment bindings, and state-root paths but returns no files for the shared harness to materialize. Codex may generate its conditional secret-free patch descriptor under [Logical Model Patch Capability](20260716-codex_worker_adapter.md#logical-model-patch-capability); Pi's credential-free model descriptor is SDK input, not a generated file, under [Provider And Credentials](20260716-pi_worker_adapter.md#provider-and-credentials). Neither layer may materialize upstream MCP server commands, endpoints, credential references, or credentials for this NanoCore-managed supply or its external Gateway projection. Worker-owned in-Sandbox tools and MCP configuration are excluded from that prohibition under [Sandbox](../core/sandbox.md); the rationale is recorded in [Full Permission Inside The Sandbox](../decisions/20260930-full_permission_inside_the_sandbox.md). Every worker package permits only the fixed authenticated Integration route for its resolved MCP supply.

Static MCP supply alone does not grant a callable tool route. Only exact selected supply plus the matching active package and capability token admits the implemented `/capabilities/mcp/*` Integration family and NanoCore-owned policy; remote MCP and the administrator CLI are not part of this path.

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

Private Harness polling, operation sequencing, and reconnect result replay follow [Worker Control Protocol](20260703-worker_control_protocol.md#harness-pull-and-result-envelopes); a dispatched Harness effect is never redelivered.

After readiness, retry must preserve the same logical operation identity, worker sequence, and canonical payload fingerprint. Sandbox Integration retries only the AEP-resolved sandbox-local worker-control binding, pauses new private Harness polling and new control-dependent work while disconnected, and does not create an unbounded offline outbound queue.

Live append must work with turn-end transcript import.

If a live record was already accepted, transcript import must deduplicate it instead of creating duplicate Items. Artifact submission replay follows its request-owned tuple and receipt above; closeout neither discovers nor repeats submitted Artifacts.

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
- Collected Workspace output is not authority to mutate a hosted repository. Platform-managed hosted effects use their separately admitted Gateway MCP owner. Native Git push remains optional user-space configuration requiring a user-injected credential and admitted git-receive-pack egress; OpenKit adds no native-push mechanism.

Invalid change records should create diagnostics and fail or block the turn according to AEP policy.

They must not be silently applied.

## Diagnostic Commands

No diagnostic command family is implemented or declared by the current worker contract. A future diagnostic operation requires a separately accepted closed typed contract with policy binding and bounded arguments; arbitrary argv, cwd, environment, or shell input is permanently excluded.

## NanoHost Deployment Independence

Every NanoHost deployment shares the same Worker-facing contract and product semantics.

Every deployment uses one configured NanoHost and the same Sandbox Integration boundary. Every active sandbox receives only sandbox-local bindings for `/worker-control/*`, `/inference/*`, and `/capabilities/*`. Sandbox Integration carries the enabled logical route families through the sandbox's one stock RelayStream and its one standard HTTP/2 session; it never exposes a NanoCore address or remote transport endpoint to the Worker Agent. Every admitted worker has a callable capability binding for its resolved MCP supply.

Host topology may change the native data-transfer implementation owned by `docs/specs/20260801-nanohost_workspace_data_boundary.md`. Workspace, Artifact, image, and model bytes remain outside the control HTTP/2 session.

No deployment topology gives NanoCore a second lifecycle channel or gives the sandbox a separate NanoCore control path. NanoHost lifecycle, Runtime Epoch fencing, one-session carriage, and RelayStream ownership are governed by `docs/specs/20260802-nanohost_runtime_and_transport.md`.

These differences must not leak into Worker records, public App API, end-user CLI operations, Web UI, Goal Mode, Action Center, or review semantics.

## Failure And Recovery

Before the complete route-bound worker-control readiness exchange succeeds, required control failure is fail-fast and Sandbox Integration must not launch the main Worker Agent child.

Retry remains disabled until the main Worker Agent child starts, so an interruption before launch is fail-fast. After launch, a retryable worker-control interruption enters the single bounded outage budget owned by `docs/specs/20260703-worker_control_protocol.md`. The worker-control client inside Sandbox Integration keeps the same child alive while pausing new private Harness polling and new control-dependent work and retrying only the same AEP-resolved sandbox-local binding with the same logical operation identity; the Integration carriage itself does not retry or reinterpret the request.

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

Sandbox tokens and raw worker process keys do not need to be persisted as reusable secret material. Sequence zero binds only the process-key hash to the lease, while sequence one proves that post-launch retry is active and the resident host has begun the Turn. A transport loss or a NanoCore restart may adopt the exact attempt: adoption then requires the original in-memory key, exact durable lineage, the exact next sequence, and the unexpired `awaiting-reconnect` lease. It adds no compatibility registry or challenge protocol. A binding that cannot be proved exactly is closed or fenced, and a successor resumes natively. This version starts from a new data root and does not read earlier-version data, as [the engineer decided](../decisions/20260930-earlier_version_data_not_carried.md).

When exact adoption succeeds, the existing worker-Turn checkpoint, AgentSession, and Workspace synchronization records continue terminal observation, evidence collection, review, and cleanup for the same Turn. When key, lineage, sequence, or deadline verification fails, those same owners project the interrupted outcome and reconciliation path. The shim seals the transcript and provenance it owns before `final_status`. It does not publish the workspace change set by an in-Sandbox capture, and process-group absence is not the collection gate. A durable accepted final status closes through the existing backend, checkpoint, Workspace, Turn, lease, and capacity records; no settlement coordinator or parallel domain workflow exists. The next Turn waits until Turn-end collection completes.

The reconnect contract adds no second protocol or recovery owner. Sandbox Integration, RelayStream, and the NanoHost session preserve transport confidentiality and the distinct worker-control token boundary defined by the runtime-and-transport owner. A NanoHost or Execution Server failure that cannot prove continuity leaves the Turn with the truthful result its lifecycle owner determined; effect uncertainty and any recovery requirement are expressed by the effect owner and the recovery owner respectively, without changing any independent AgentSession result, and it never infers completion, replacement, or settlement.

## Public Surfaces

Public App API, the end-user remote MCP interface, Web UI, deployment docs, and status summaries should describe:

- Core mode: `local | server`
- Worker runtime: `container`
- Runtime target: one configured NanoHost
- Container backend: stock OpenShell private to NanoHost

They should not advertise host execution as a supported Worker runtime.

Remote MCP and the administrator CLI are the implemented channel projections over NanoCore public APIs. They use definition-derived operation projections and do not expose a second workflow or route authority.

The transport-neutral operation catalog may need operations to inspect worker runtime status, worker communication diagnostics, supply catalog summaries, capability call summaries, and staged review evidence.

It must not become worker-side MCP supply and must not expose backend-private sandbox control.

## Implementation Roadmap

Implementation should move through these release-neutral milestones:

1. Remove host Worker runtime from product selection and public surfaces.
2. Promote canonical worker schemas into `packages/worker-protocol`.
3. Replace both adapter modes with the one resident contract for Codex, Pi, OpenCode V2, and DeepSeek, carried by the six Harness operations, without adding another runtime protocol.
4. Complete live candidate event append, NanoCore validation, and transcript import deduplication through Sandbox Integration's `/worker-control/*` binding.
5. Complete NanoCore-resolved Skill and MCP supply catalog materialization into container workers.
6. Extend the implemented selected-MCP capability slice only through separately accepted capability owners; Knowledge Store operations and other families remain future work and must not add another control path.
7. Keep remote MCP, bundled CLI, and operation catalog aligned as public runtime-communication operations land so coordinator agents can inspect and drive them through public NanoCore APIs.
8. Verify the full loop through public NanoCore APIs and the remote MCP interface without relying on backend-private runtime state.

## Verification Expectations

The communication model is implemented only when:

- no real product runtime path uses host execution
- every supported NanoHost deployment generates the same AEP Worker-facing control contract
- every supported NanoHost deployment uses the same Sandbox Integration, RelayStream, worker-control protocol, transcript schema, event schema, exact disabled-or-selected-MCP capability declaration, and Workspace-change schema
- NanoCore validates candidate records against canonical schemas without importing runtime-native adapters
- Runtime adapters own runtime-native argv, protected environment binding derivation, isolated state paths, and output parsing; admitted public native environment values remain AEP inputs; Codex's conditional patch descriptor and Pi's SDK model descriptor remain adapter-owned and credential-free, while the shared Harness has no native config-file contract
- a further runtime adds one authored `AgentManifest`, one adapter module plus static registry entry, inside the one multi-runtime image, without a NanoCore enum branch, command builder, native parser, or image-selection branch
- base-path runtime-native command construction and event parsing occur only in the corresponding adapter, specification, and tests; images and manifests declare binaries and policy but no native argv; the resident contract keeps the restricted live handle until `session.close` and a successor resumes that retained conversation; opaque native bytes may persist in the admitted data volume; the only NanoCore native-parser exception is the narrowly isolated version-pinned S33 verifier
- Skill and MCP supply comes from NanoCore-resolved catalog snapshots
- selected MCP capability routes pass their governed catalog, schema, policy, approval, usage, audit, credential, and teardown acceptance before roadmap closure; Knowledge, context, and proposal-flow routes remain unadvertised
- no App API, NanoCore route, gateway method, or Sandbox Integration interface accepts or executes caller-supplied arbitrary argv, cwd, environment, or shell input
- tests prove token, lineage, schema, sequence, idempotency, digest, workspace path, and policy validation
- tests prove pre-readiness failure launches no worker, retryable post-readiness interruption preserves the same worker within the bounded budget, exact process-key/lineage/sequence adoption creates no replacement worker or session, and budget expiry enters the existing interrupted recovery path
- e2e smoke proves one configured NanoHost can run two Turns on one non-Goal resident binding without relaunching the native engine, produce reviewable evidence, leave the binding open across those Turns, close it with `session.close` while preserving resumable native context and retained working roots, and preserve the compatible shared Sandbox and healthy Runtime Epoch. Goal worker execution is not the acceptance path for this change. That limit is current implementation that the Goal implementation replaces, as [Goal](20261002-goal.md) defines
- real-host fault acceptance proves the same NanoHost and Sandbox Integration contract, stock RelayStream carriage, Sandbox materialization, separately governed data transport, and fresh-empty readiness after Runtime Epoch recovery
- real Codex provenance acceptance proves the attributed remote inference path; that gate has passed on A1, while the selected MCP slice requires its separate R058 acceptance and the broader non-MCP capability plane remains partial
- Agent-Skill-driven dogfood loops prove the coordinator can inspect runtime status, run bounded steps, review evidence, and continue/refine/reject/accept without bypassing review gates

## Testing Strategy

Required local development machine verification:

- format and static checks for touched packages
- schema and contract tests for `packages/worker-protocol`, `packages/config-schema`, `packages/app-api-schemas`, and `packages/core-client`
- NanoCore unit and black-box tests for runtime selection, AEP generation, route-bound worker-control, event append, transcript import, workspace validation, and Action Center review projection
- Sandbox Integration tests for worker-control binding, exact one-route enforcement, transcript writing, redaction, bounded output, and sequence handling, plus adapter-local tests for native argv, environment isolation, and parser behavior
- Sandbox Integration tests for pre-readiness fail-fast behavior, same-operation replay, paused private Harness polling, same-worker adoption after a transport loss or a NanoCore restart, and a restart whose proof fails and therefore closes or fences the binding, recovery timeout, and terminal handoff through existing checkpoint, session, and workspace records
- selected-MCP capability tests for route authentication, server listing, tool listing and calls, policy, approval, usage, audit, credential redaction, teardown, and fail-closed disabled projection; future Knowledge operations require their own checks before advertisement
- bundled CLI tests, build, and smoke against a local NanoCore development server
- a real Agent-Skill-driven non-Goal resident loop through one configured NanoHost. Goal worker execution is not this acceptance path

Required real-host verification:

- run NanoCore in server mode
- run the configured NanoHost with one fresh, verified-empty Runtime Epoch
- provide each sandbox one stock RelayStream carrying one standard HTTP/2 session with the sandbox-local `/worker-control/*` and `/inference/*` bindings, while proving that `/capabilities/*` remains absent and disabled
- connect from an MCP-capable agent app through the remote guide and tools
- create or resume a real thread
- run two Turns on one non-Goal resident binding through that RuntimeTarget. Goal worker execution is not this acceptance path
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

Risk: Remote recovery after a transport loss or a NanoCore restart adopts the wrong worker or extends an outage indefinitely.

Mitigation: require the exact memory-only process key, durable lineage, next sequence, and preserved deadline; claim reconnect and apply the ordinary heartbeat update in one database transaction while timeout cleanup uses one exact-row CAS, so only one side can win; fall back to the existing interrupted-evidence path on any mismatch or timeout. After a transport loss or a NanoCore restart, a binding that cannot be proved exactly is closed or fenced, and a successor resumes natively.

## Decisions

- Host runtime is removed from product execution and public surfaces.
- Public runtime configuration exposes one NanoHost identity and rendezvous boundary, not a worker-runtime, placement, backend, SSH, Gateway, or sandbox-direct endpoint selector.
- Sandbox Integration's sandbox-local `/worker-control/*` binding is the sole Worker-facing target for worker control. The `/inference/*` and future `/capabilities/*` families share only the standard HTTP/2 carriage and retain separate tokens, scopes, payload bounds, retry rules, failure semantics, usage, and audit ownership.
- NanoHost lifecycle, Runtime Epoch fencing, stock RelayStream carriage, standard HTTP/2 session ownership, and transport credential boundaries are owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`.
- The AEP carries one preferred logical model and an exact non-empty allowed route set. The shared shim validates the complete allowed route set, requires a unique route for the preferred model, and passes both the exact admitted set and this Turn's preferred route into the adapter-specific fail-closed native projection; it permits multiple routes only in Gateway mode and never falls back to another model. The selected Codex adapter uses App Server session configuration, Pi uses its SDK-host model descriptor, and OpenCode V2 uses private native configuration and its supported client API under their adapter owners; deployment pins are recorded in `containers/worker-runtimes/versions.json`. Each projection targets the selected trusted NanoCore relay and must satisfy its adapter owner; descriptor generation alone does not prove live Task readiness.
- `openkit-worker-shim` is the generic real container entrypoint; runtime-native behavior is selected by the AEP-declared opaque adapter id inside the worker image.
- Codex, Pi, OpenCode V2, and DeepSeek use one shared Harness registry and one resident adapter contract. A runtime that cannot keep live context, or cannot resume the exact retained conversation, is an unsupported capability.
- One authored `AgentManifest`, one adapter module plus static registry entry, inside the one multi-runtime image, are the complete permitted production extension surface for a further Worker Agent. `worker-common` remains the public base.
- The resident contract retains one restricted live handle until `session.close` and a successor resumes that retained conversation, while preserving the opaque data volume. `turn.interrupt` cancels the Turn and does not close the AgentSession. Resident observation keeps the 16 MiB capture bound and the 16 KiB-per-stream diagnostic-prefix bound.
- Selected MCP capability routes are enabled only by exact AEP supply and active Turn authority; all other capability routes remain disabled, and static supply never authorizes direct upstream execution.
- S33 Codex provenance remains a separate optional verified extension and is not part of the common adapter contract.
- Live candidate event append and NanoCore validation should be implemented before broad Skill, MCP, knowledge, and context capability work.
- Dynamic Skill and MCP updates create new AEP snapshots. Tool-surface changes happen at Turn boundaries. Each adapter declares whether its runtime lists tools again at Turn start.
- Sandbox Integration redaction is best effort; NanoCore redaction and verification remain authoritative.
- No diagnostic command exists in the current contract; any future typed diagnostic is separately designed and cannot accept arbitrary execution input.
- Required route-bound worker control is fail-fast before readiness and bounded-reconnect after readiness; successful process-key adoption continues the same worker and existing terminal-handoff records, while verification failure or timeout follows the existing interrupted recovery path.

## Specialized Decision Index

This overview records the worker runtime communication direction. Detailed implementation decisions live in the narrower specs that own each contract:

- Worker-control live append route shape, envelope semantics, event sequence idempotency, stale/conflicting sequence handling, and response fields are owned by `docs/specs/20260703-worker_control_protocol.md`.
- Runtime-internal sub-agent raw capture, parent-child provenance, trusted worker-inference identity, and runtime cache lineage are owned by `docs/specs/20260711-worker_runtime_subagent_provenance.md`.
- Worker capability route projection, canonical `knowledge.*` target families, sandbox bearer lineage, `WorkerCapabilityCallSummary`, metering, and audit hooks are owned by `docs/specs/20260703-worker_agent_capability.md` and `docs/specs/20260702-knowledge_store_governance_rules.md`.
- Worker-side Skill and MCP catalog resolution, approved catalog ids, version or digest resolution, runtime-adapter compatibility, and provider and Vault references are owned by `docs/specs/20260703-agent_manifest_aep_resolution.md`, `docs/specs/20260703-worker_agent_capability.md`, and `docs/specs/20260704-worker_mcp_tool_supply.md`; the AEP carries their resolved static supply projection and admitted public native environment inputs, while adapter-specific native argv, protected environment binding derivation, state-root use, and output parsing are owned by S64-S66 and their future peer specifications.
- Filesystem workspace staging, resolved-path containment, symlink escape rejection, staged review, apply, and recovery behavior are owned by `docs/specs/20260703-workspace_synchronization.md`.
- End-user coordinator diagnostics must use public NanoCore App API surfaces rather than runtime internals. Concrete product guidance is owned by `docs/specs/20261002-remote_mcp_interface.md`; administrator CLI behavior is owned by `docs/specs/20260910-agent_operator_skill.md`.
- NanoHost lifecycle, Runtime Epoch fencing, Sandbox Integration carriage, stock RelayStream ownership, and route-family isolation are owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`; OpenShell network policy defaults, Codex binary allowlists, Git remote helper binary allowlists, and native data transfer remain with their narrower execution-environment and workspace owners.
- Restart effects use ordinary worker-control adoption plus the existing workspace synchronization, evidence-import, and bounded-step owners; no separate recovery workflows or coordinators exist. Detailed rules are owned by `docs/specs/20260703-worker_control_protocol.md`, `docs/specs/20260703-workspace_synchronization.md`, `docs/specs/20260703-audit_usage_evidence_records.md`, and `docs/specs/20260703-runtime_scheduling_scale.md`.

## Related Documents

- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20261002-remote_mcp_interface.md`
- `docs/specs/20260703-workspace_synchronization.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
- `docs/specs/20260703-runtime_scheduling_scale.md`
