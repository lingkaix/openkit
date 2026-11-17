---
status: Accepted
implementation: Partial
kind: boundary
aspect: runtime-model
---
# Worker Runtime Sub-Agent Provenance And Inference Identity

This specification owns runtime-origin evidence for one worker execution. It separates outer OpenKit lineage, native causal origin, and prompt-cache routing.

## Scope

This specification owns raw capture when `worker.runtime-provenance.v1` is required, the normalized origin index, the two automatic evidence producers, the live inference hint, and cache-lineage routing for worker inference.

It does not own the raw-output Budget. [Worker Turn Reliability](20260531-worker_turn_reliability_envelope.md#worker-raw-output-accounting) owns that aggregate.

It does not own EvidenceBundle or RuntimeEvidence row shapes. [Audit, Usage, And Evidence Records](20260703-audit_usage_evidence_records.md) owns those shapes.

It does not own listener, token transport, or the OpenShell pin. [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md) owns them.

It does not own the selected MCP plane. [Worker Agent Capability](20260703-worker_agent_capability.md) owns that plane.

It does not own a product execution graph or a tracing platform.

Core: [Architecture](../core/architecture.md), [AgentSession](../core/agent-session.md), [Mediation](../core/mediation.md), [Evidence](../core/evidence.md), [Storage](../core/storage.md).

## Raw Emission Attribution

[Worker Turn Reliability](20260531-worker_turn_reliability_envelope.md#worker-raw-output-accounting) owns the one atomic raw-output aggregate. The authenticated inference path supplies trusted Turn and provider-attempt identity before response buffering can discard failed-attempt output. Attribute primary and concurrent child emissions to that same Turn. Deduplication uses trusted attempt, emission/content-part identity, and stream position; native origin hints, equal text, and equal digests cannot suppress a charge.

Mechanically forwarding a child result adds no emission; generated parent text does. Retain bounded accounting evidence through Turn recovery without acquiring hidden reasoning or placing exposed reasoning text, raw provider payloads, or secrets into normal logs. Qualify every admitted inference/child route and restart before claiming uniform enforcement. Missing observability blocks the affected route; existing provenance completeness alone does not prove accounting completeness.

## Decision

OpenKit models worker-internal sub-agent execution through three separate identity dimensions.

| Dimension | Purpose | Authority | Typical values | Persistence |
| --- | --- | --- | --- | --- |
| OpenKit worker lineage | Ownership, permission, review, accounting, scheduling, and product history | Authoritative after NanoCore validates the worker session binding | Workspace, thread, turn, AgentSession, package snapshot, request | Canonical records and ledgers |
| Runtime origin | Causal reconstruction inside one worker execution | Evidence only; never grants authority | Runtime family, native session, native thread, parent native thread, native turn, role, depth | Restricted raw evidence plus a product-safe normalized index |
| Runtime cache lineage | Stable routing for requests expected to share an exact prompt prefix | Performance hint only; never grants authority or proves causality | Runtime-provided cache lineage or an adapter-declared equivalent | Product-safe ref on `CapabilityCall`; raw value is not stored |

One runtime-internal parent and all of its runtime-internal children share the same OpenKit worker lineage. They normally have distinct runtime origins. They may have distinct or intentionally shared runtime cache lineage, depending on the runtime's declared cache semantics.

NanoCore does not create a `SubAgent` entity, a child `AgentSession`, a child OpenKit `Thread`, or a child OpenKit `Turn` for runtime-internal children. If a child needs independent permission, budget, scheduling, retry, recovery, review, or user-visible ownership, NanoCore must launch it as a separate bounded worker execution with its own Core lineage instead of treating it as a hidden runtime child.

For the first governed Codex adapter, the worker image, generated app-server schema snapshot, pinned fixtures, and adapter capability declaration MUST all target the one Codex version that [Codex Worker Adapter](20260716-codex_worker_adapter.md) pins. A parser tested against another version MUST NOT advertise `worker.runtime-provenance.v1`. [Codex Worker Adapter](20260716-codex_worker_adapter.md) records the deployed pin. The resident adapter does not advertise runtime provenance for that pin. Historical fixtures do not qualify it. The accepted runtime is Codex App Server v2.

## Relationship To The Worker Adapter Boundary

This specification is an optional Codex security and evidence extension outside the base Worker Agent adapter contract and its fourth-runtime criterion. A bounded runtime may satisfy the base contract without implementing runtime provenance, but it MUST NOT advertise `worker.runtime-provenance.v1` or claim native-origin completeness.

Independent verification of adapter-produced Codex origin claims remains mandatory when this feature is enabled. NanoCore MAY therefore retain one narrowly isolated, version-pinned Codex native verifier owned by this specification; that exception does not authorize native event schemas, runtime branches, or runtime-specific unions in generic AEP resolution, worker governance, scheduling, worker control, canonical worker protocols, public APIs, or the shared worker harness.

Adding a fourth base adapter MUST NOT modify or depend on the Codex verifier. A future runtime that needs equivalent native provenance requires a separately accepted optional extension with its own isolated verifier and evidence contract; that work does not broaden the shared adapter interface or retroactively add provenance obligations to other runtimes.

This extension uses the separately governed worker-inference binding. It does not enable or disable the selected MCP plane. [Worker Agent Capability](20260703-worker_agent_capability.md) owns that plane. [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md) records the exact OpenShell pin and the stock-feasibility precondition.


## Contract / Expected Behavior

### 1. Outer Worker Lineage Remains Authoritative

- `WorkerLineageSchema` remains the authority-bearing worker lineage contract and remains unchanged by this design.
- All runtime-internal activity produced within one AEP snapshot MUST bind to the same expected `workspaceId`, `threadId`, `turnId`, `agentSessionId`, and `packageSnapshotId`.
- Runtime-native ids MUST NOT replace or override any OpenKit lineage field.
- A runtime-native parent-child relation MUST NOT imply an OpenKit handoff, delegation, new turn, new thread, or new AgentSession.
- Canonical items and artifacts remain owned by the outer OpenKit turn after NanoCore verification.

### 2. Runtime Provenance Capture

Sub-agent-capable runtime adapters MUST produce a bounded raw stream set plus two index files when the AEP requires `worker.runtime-provenance.v1`:

```text
/openkit/threads/<threadId>/<harness>/capture/<turnId>/runtime/raw/
  stream-0000.jsonl
  stream-0001.jsonl
  ...
/openkit/threads/<threadId>/<harness>/capture/<turnId>/runtime/raw-streams.json
/openkit/threads/<threadId>/<harness>/capture/<turnId>/runtime/native-origin-index.jsonl
```

`raw/stream-0000.jsonl` is the byte-preserved primary runtime stream, the Codex App Server v2 event stream. The shim MUST stream this output to disk while the process runs and MUST NOT retain the complete stream in memory.

Additional `raw/stream-*.jsonl` files are byte-preserved runtime-native per-thread streams reachable from the primary runtime thread. For the first Codex adapter, these are the root and child rollout JSONL files selected by runtime-native thread metadata and spawn edges. The adapter MUST copy them under synthetic stream names so native ids and backend paths do not leak through product-safe filenames.

`raw-streams.json` is a restricted manifest that lists each synthetic stream ref, source kind, byte size, SHA-256 digest, physical frame count, capture status, and whether the stream reached a stable terminal boundary. It MUST identify the primary stream without embedding a native thread id in its product-safe locator.

`native-origin-index.jsonl` is an adapter-produced restricted index. Each line maps one physical raw frame in one manifest stream to runtime-native origin fields without rewriting the raw frame.

Each native origin index entry is a `WorkerRuntimeNativeOriginIndexEntrySchema` value in `packages/worker-protocol/src/index.ts`. The manifest is a `WorkerRuntimeRawStreamManifestSchema` value in that same file.

Runtime-native ids in this file are restricted evidence. They MUST NOT be copied into canonical items, public App API records, remote MCP or administrator CLI responses, worker-side MCP responses, usage records, audit rows, product logs, or normal diagnostics.

Every physical raw frame in every manifest stream MUST have exactly one index entry. A runtime-global event may be `unattributed` with no runtime thread id. An unknown event kind may remain `parsed` when frame boundaries and origin are still trustworthy. A malformed or truncated frame MUST remain represented and MUST NOT be silently assigned to the parent thread.

The adapter MUST discover child streams by traversing runtime-native spawn edges or parent-thread metadata from the primary runtime thread. It MUST NOT collect every file under a shared runtime home by timestamp or directory scan alone. A child referenced by the reachable graph but missing from the collected stream set, still running, or still changing at collection time makes provenance incomplete.

The native runtime MUST retain its own unchanged file structure under `/openkit/threads/<threadId>/<harness>/native/`. The adapter collects per-Turn evidence under `/openkit/threads/<threadId>/<harness>/capture/<turnId>/` and closes its writers when the Turn ends; a sealed capture is not overwritten by another Turn. `<harness>` is the stable adapter id (`codex`, `pi`, `opencode`, or `deepseek`), not an ephemeral process or Harness Instance id. The existing collector-relative `runtime/` child is retained beneath the capture directory. The AEP transcript declaration MUST name that capture root's `runtime/raw`, `runtime/raw-streams.json`, and `runtime/native-origin-index.jsonl`, plus positive maximum total bytes and stream count. The current default declaration is 256 MiB total and 64 streams. No native data or capture of different runtime families is mixed.

Thread-level isolation inside a shared Sandbox is not provided. Threads that share a Sandbox can read each other's files. Directory separation prevents collisions, not cross-Thread reads or confidentiality breaches; it MUST NOT be represented as a security boundary. Synthetic stream refs MUST match `stream-<four decimal digits>.jsonl` and MUST resolve only beneath the declared raw root. Reaching either limit MUST close capture cleanly, mark remaining provenance `truncated`, and prevent the turn from being represented as provenance-complete.

### 3. NanoCore Normalization And Reconstruction

NanoCore MUST verify the raw stream and native index before promotion.

Verification MUST cover:

- outer lineage equality with the registered AEP snapshot
- supported runtime adapter and index schema versions
- raw stream manifest validity, unique synthetic stream refs, and safe relative paths
- every listed stream's digest, byte size, frame count, and terminal capture status
- frame sequence ordering
- byte range bounds and non-overlap
- per-frame digest equality
- agreement between adapter-declared event, origin, parent, turn, role, and depth fields and the structural fields re-parsed from the corresponding raw frame under the pinned adapter schema
- one index entry per physical raw frame across every listed stream
- primary runtime origin presence and closure of every reachable child edge
- parent reference existence for every non-root runtime origin
- absence of parent cycles
- non-negative and internally consistent depth when depth is supplied
- declared completeness state

[Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md#ids) owns the shared canonical JSON digest. These retained refs are a named exception. NanoCore MUST mint product-safe opaque `runtimeOriginRef` values for runtime-native origins and `runtimeTurnRef` values when native turns are available. An origin ref is `rto_` plus the first 24 hexadecimal digits of SHA-256 over the literal `packageSnapshotId:nativeThreadId`. A turn ref is `rtt_` plus the first 24 hexadecimal digits of SHA-256 over the literal `packageSnapshotId:nativeTurnId`. A bundle id is `evb_` plus the first 24 hexadecimal digits of SHA-256 over the literal `kind:packageSnapshotId`. Minting MUST be deterministic for the same package snapshot and native origin so live inference calls and turn-end normalization converge on the same ref after retry or restart. A reader MUST NOT replace these retained bytes with the shared canonical JSON encoding. NanoCore MUST create a normalized origin index that keeps outer lineage, synthetic stream refs, physical frame coordinates, product-safe origin refs, parent origin refs, normalized event kinds, role and depth summaries, and parse status while omitting every runtime-native id and nickname. An unknown event kind or role maps to `other`. The same package snapshot and native thread mint the same opaque origin ref. That ref is not a cross-Turn identity.

Runtime-origin refs attached to live worker-inference calls are provisional until turn-end provenance verification. Before promoting the normalized bundle, NanoCore MUST query every AEP-bound worker-inference `CapabilityCall` for the package snapshot and prove that each non-null `runtimeOriginRef` resolves to exactly one origin in the normalized index. A provenance-capable adapter MUST supply a non-null origin ref for each call it routes through the authenticated worker-inference path. A missing or unmatched ref makes gateway attribution incomplete, quarantines the normalized provenance result, and prevents the turn from claiming complete provenance; the durable capability call remains as an audit record and MUST NOT be silently rewritten to the root origin.

The normalized index MUST represent a forest because one worker execution may contain more than one runtime root. A frame with no trustworthy runtime origin remains explicitly unattributed.

Given a retained evidence bundle and one `runtimeOriginRef`, an authorized analyzer MUST be able to determine which raw frames belong to that origin, its parent origin, its child origins, and the shared outer OpenKit lineage. The analyzer MUST NOT need to reinterpret all records as one OpenKit transcript.

NanoCore MUST NOT translate raw runtime child messages into canonical OpenKit items by default. The adapter may continue producing bounded product-safe progress summaries and the final outer result through existing worker transcript records. Raw runtime events remain evidence.

### 4. Evidence And Retention Projection

This design reuses the existing record shapes without modifying `EvidenceBundle` or `RuntimeEvidence`.

After successful verification, NanoCore MUST automatically create two workspace-owned EvidenceBundle records because restricted raw streams and the product-safe normalized index have different retention and export rules.

The restricted raw bundle MUST contain:

- `sourceKind: "worker-runtime-provenance-raw"`
- the outer workspace, thread, turn, and AgentSession lineage
- restricted raw references for `raw-streams.json`, every listed raw stream, and `native-origin-index.jsonl`
- content digests for the manifest, index, and every retained stream
- `retentionClass: "restricted-raw"`
- `sensitivityClass: "restricted"`
- `importStatus: "promoted"`
- `requiredFeatures` containing `worker.runtime-provenance.v1`

The product-safe normalized bundle MUST contain:

- `sourceKind: "worker-runtime-provenance-index"`
- the same outer lineage
- no raw evidence refs
- a redacted reference and digest for the normalized runtime-origin index
- `retentionClass: "turn-evidence"`
- `sensitivityClass: "product-safe"`
- `importStatus: "promoted"`
- `requiredFeatures` containing `worker.runtime-provenance.v1`

NanoCore MUST produce one transcript-collection RuntimeEvidence record for this flow. The implemented deterministic producer's product-safe summary reports capture completeness, raw stream count, raw frame count, attributed frame count, unattributed frame count, runtime root count, child origin count, AEP-bound worker-inference call count, origin-reconciled call count, gateway-attribution completeness, and both EvidenceBundle ids. The existing RuntimeEvidence shape and `evidenceBundleIds` linkage are sufficient; existing materialization and teardown producers remain separate.

Malformed lineage, missing reachable streams, unstable child streams, digest mismatch, invalid frame mapping, cycles, unsupported local capture features, or prohibited raw identifiers in the normalized index MUST quarantine the restricted raw bundle, prevent promotion of the normalized bundle, and prevent claims of complete provenance. An export carrying unknown required features fails closed at verification.

The raw stream manifest, raw streams, native index, and their locators MUST NOT be returned by normal App API, Core Client, remote MCP, administrator CLI, worker-side MCP, Web, audit, usage, or diagnostics surfaces. NanoCore stores restricted files under `evidence/backend/<rawBundleId>/` and the product-safe normalized index under `evidence/bundles/<indexBundleId>/runtime-origin-index.jsonl`; logical refs are bundle-relative and never contain host paths or native ids. The internally stored restricted bundle retains governed raw refs, but every ordinary projection of that `restricted-raw` runtime provenance bundle MUST return `rawEvidenceRefs: []`; projections of other automatic EvidenceBundle producers remain unchanged. Default workspace export MUST retain the normalized index file and product-safe bundle. When restricted raw export is not explicitly authorized, export MUST retain only an expired source-digest bundle row with empty raw refs so RuntimeEvidence linkage does not dangle; its digests describe omitted source evidence and MUST NOT claim local re-verifiability. It MUST NOT include restricted raw files or locators.

Ordinary portable Workspace import is absent and does not remint this index. Export retains the normalized index and does not copy restricted raw provenance files. Automatic bundle and RuntimeEvidence writers MUST use deterministic ids and exact-content replay checks; an equal restart replay is accepted and a divergent replay under the same id fails. Interrupted-worker recovery explicitly re-runs verification from the stable evidence directory before terminal recovery; NanoCore does not add a boot-wide provenance scanner.

Manual EvidenceBundle creation is not part of this flow. Both worker runtime provenance bundles are produced only by the NanoCore transcript-collection boundary.

### 5. Trusted Worker Inference Binding

The trusted logical target `inference.local` is exposed only inside the sandbox at the adapter-owned fixed URL `http://127.0.0.1:17892/inference/v1`. Sandbox Integration projects its OpenAI-compatible Chat Completions and Responses operations through `/inference/*` on the one standard HTTP/2 session carried by the sandbox's one stock RelayStream. The AEP carries the semantic binding and token reference but no native URL. `/worker-control/*` and `/capabilities/*` share carriage only; they retain distinct credentials and semantics.

The AEP binds one short-lived inference token or non-secret reference to the exact package snapshot, active execution attempt, selected provider and model, and permitted runtime-origin hint contract. That token MUST be rejected by `/worker-control/*` and `/capabilities/*`, and neither the worker-control token nor capability token may authenticate inference. Sandbox Integration keeps raw token material out of the native runtime's prompt, request body, normal files, logs, and diagnostics.

Inference requests MUST preserve OpenAI-compatible request and response bodies, streaming SSE, client cancellation, `prompt_cache_retention`, and supported request compression or decompression required by the pinned adapter. One worker request is rejected before provider dispatch when either its encoded aggregate or its decoded aggregate crosses the current default of 16 MiB. An equal size remains admitted, subject to JSON, schema, and current authorization. Transport layers may enforce the encoded ceiling earlier. They do not own another semantic limit. This input ceiling is not the Turn raw-output Budget. Request-body `metadata.openkit`, arbitrary authority headers, provider selectors, model overrides, package ids, and workspace lineage MUST NOT establish or override authority. Conflicting authority fields fail with `worker_inference_lineage_mismatch`, and each accepted request receives a fresh capability request id.

Before launch, the NanoHost MUST prove that root and child runtime calls use only the fixed loopback `inference.local` projection, the distinct inference binding reaches only `/inference/*`, runtime session/thread/sub-agent hints survive, sandbox-supplied credentials cannot replace the binding, direct provider credentials and egress are absent, and the required streaming, cancellation, flow-control, and compression behavior works through stock OpenShell. The retained Unit F gate proves the generic RelayStream plus nested standard HTTP/2 path; it does not replace this provenance-specific root, child, hint, credential, streaming, and cancellation gate. Failure or indeterminate evidence blocks this optional implementation without a sidecar, direct NanoCore route, SSH path, Gateway forward, custom mux, OpenShell fork, or patch.

Credential or grant revocation terminates the affected sandbox. If deletion cannot be proved, the NanoHost invalidates the complete Runtime Epoch and keeps capacity fenced until fresh-empty readiness; cleanup does not prove recall. An inference call without a valid active AEP and execution-attempt binding fails closed with `worker_inference_unauthorized`.

The existing public `/v1/chat/completions` and `/v1/responses` routes remain generic public Gateway routes. Their caller-supplied metadata may support best-effort public attribution, but it is not accepted as worker authority.

### 6. Runtime Call Origin

Each runtime adapter that declares `worker.runtime-provenance.v1` MUST define a pinned, allowlisted mapping from its native inference request fields to an internal `WorkerInferenceRuntimeHint`.

The normalized hint is `WorkerInferenceRuntimeHint`, validated by `runtimeHintSchema` in `apps/nanocore/src/llm/worker-inference-runtime-hint.ts`. The hint has no inherited-context boolean. The request phase is consumed before Provider dispatch. It is not a retained provenance field. The adapter mapping strips native inputs. The Gateway sanitizes the hint before dispatch.

The relay MUST remove runtime-native hint fields before sending the request upstream. NanoCore MUST resolve the native thread hint to the same product-safe `runtimeOriginRef` used by the normalized provenance index, treat the live mapping as provisional, and reconcile it at turn end as defined above.

Runtime hints are causal and performance inputs only. They MUST NOT alter workspace, thread, turn, AgentSession, package, provider, model, permission, vault, budget, or policy ownership.

A sub-agent-capable adapter that cannot supply a stable runtime thread hint MUST NOT declare complete runtime provenance. When the AEP requires complete provenance, capability negotiation or the worker turn MUST fail rather than silently attributing every inference call to the outer root.

### 7. Prompt-Cache Lineage

The worker inference path MUST treat runtime cache lineage as separate from both outer OpenKit lineage and runtime causal origin.

For an authenticated worker request, the pinned adapter resolves cache lineage in this order and passes only the resulting semantic decision to the Gateway:

1. An explicit runtime cache-lineage field.
2. A request-scoped generated fallback when no declared runtime cache lineage exists.

OpenKit does not infer cache inheritance from parentage. No inherited-context boolean supplies that inference.

The worker path MUST NOT derive a shared cache key solely from the outer OpenKit `threadId`, `turnId`, or `agentSessionId`. Those values are shared by all runtime-internal children and would collapse unrelated child cache routing.

The worker path MUST NOT forward or store the raw runtime cache lineage value. The cache identity is a named exception to the shared canonical digest. Its seven fields are `accountSlotId`, `model`, `nativeCacheLineageId`, `providerId`, `runtimeFamily`, `subscriptionProviderId`, and `workspaceId`. One hash is SHA-256 of `openkit:worker-prompt-cache-key:v1`, a NUL byte, and the canonical JSON text of those fields. The upstream `prompt_cache_key` is `openkit:responses:` plus the first 32 hexadecimal digits. The other hash is SHA-256 of `openkit:runtime-cache-lineage-ref:v1`, a NUL byte, and that same text. The product-safe ref is `rcl_` plus the first 24 hexadecimal digits. A reader MUST NOT replace these retained bytes with another encoding. The raw lineage value and the resulting upstream key MUST remain absent from capability rows, usage rows, audit rows, diagnostics, logs, and product APIs.

The Gateway MUST also mint a distinct product-safe `runtimeCacheLineageRef` for analysis. Equality of this ref means only that OpenKit intentionally routed the calls under the same cache lineage; it does not prove a cache hit or causal parentage.

If a runtime gives a child a distinct cache lineage, the child receives a distinct upstream key. If a runtime explicitly reports that a child inherited the parent prefix and cache lineage, OpenKit preserves that equality while keeping `runtimeOriginRef` distinct. A parent-child relation by itself is not enough to infer cache inheritance, and OpenKit MUST NOT guess shared cache lineage from provenance alone. Actual cache hits still depend on provider-specific prefix and routing behavior.

When no runtime cache lineage is available, the Gateway MUST use a request-scoped key, leave `runtimeCacheLineageRef` null, and record a product-safe degraded-cache diagnostic. It MUST prefer lost reuse over accidental sibling sharing.

### 8. Capability, Usage, And Audit Linkage

`CapabilityCall` has one optional nullable outer-lineage field and two optional nullable product-safe correlation fields:

- `packageSnapshotId`: the authenticated AEP snapshot that supplied and governed the worker call
- `runtimeOriginRef`: the internal runtime origin that caused the call
- `runtimeCacheLineageRef`: the cache routing lineage used for the call

The shared capability ledger MUST populate outer lineage from the authenticated worker binding and MUST populate these refs from the runtime adapter mapping. It MUST generate a unique per-inference-call request id and MUST NOT reuse the outer AEP request id for every sub-agent request.

`UsageRecord` and `AuditEvent` do not need duplicate runtime fields because they already link through `capabilityCallId`. This design therefore changes the smallest durable record that can carry both causal and cache correlation.

Cached input token measurements, cache writes when a provider exposes them, total input and output tokens, provider instance, model, outer lineage, `runtimeOriginRef`, and `runtimeCacheLineageRef` MUST remain queryable through the capability-call linkage. No record may contain prompt text, raw provider payloads, raw runtime ids, or raw cache keys.

### 9. Failure And Recovery

- A worker process crash MUST preserve every flushed primary frame and every stable per-thread stream snapshot collected before the crash.
- A missing required raw manifest, primary stream, reachable child stream, or native index MUST fail the provenance requirement and MUST NOT be replaced by backend stdout summaries.
- A missing or unmatched `runtimeOriginRef` on an AEP-bound worker-inference call MUST fail gateway-attribution completeness and MUST NOT be reassigned to the runtime root.
- A runtime or backend that bypasses the required authenticated relay MUST fail capability negotiation or the turn; direct calls MUST NOT be counted as gateway-attributed activity.
- An incomplete raw stream set MAY remain as quarantined restricted evidence even when the outer turn fails.
- Live worker events and turn-end transcript import remain deduplicated by the existing worker-control sequence contract; runtime-native frame sequence is separate and MUST NOT become the canonical OpenKit item sequence.
- Retrying an outer turn creates a new package snapshot and new provenance bundles. Runtime-native ids from the failed attempt MUST NOT be merged into the retry's index.
- Interrupted-worker restart recovery MUST re-run verification from the retained stream manifest, raw streams, and native index before terminal recovery; it MUST produce the same normalized origin refs and bundle digests for the same retained inputs, and terminal recovery MUST fail if verification cannot complete.


## Incremental Observation Boundary

Incremental source-reported child facts and admitted content follow 20260921-work_data_retention_format.md under the outer Turn. They have different assurance from the verified restricted raw bundle and normalized provenance index specified here. They do not advertise worker.runtime-provenance.v1, relax its completeness/quarantine contract or erase observations when final verification fails. One shim native structural interpretation owner may serve both producers; the independently pinned Core verifier remains independent. Safe opaque origin hint correlation may operate without full-provenance advertisement, but missing attribution stays null and source hints never authorize calls or establish Core identities. Runtime-native identifiers remain restricted; ordinary observations and timeline contain only opaque refs and admitted projections.


The deployed Codex pin does not advertise `worker.runtime-provenance.v1`. The resident adapter refuses that requirement. A partial incremental observation and a live safe hint can exist without the feature. They are not a complete provenance bundle. Historical parser fixtures and a historical exec run do not qualify the deployed pin.

`WorkerRuntimeRawStreamManifestSchema` and `WorkerRuntimeNativeOriginIndexEntrySchema` in `packages/worker-protocol/src/index.ts` hold the retained manifest and native-index fields. Optional native session, thread, parent, and turn ids, role, nickname, and depth stay restricted evidence. They are never Core identity.

An automatic pair is one restricted raw bundle and one product-safe normalized bundle. The index exists only after complete verification. Invalid evidence keeps the raw quarantine and omits the promoted index. Reconciliation matches every package-bound Gateway call to a normalized ref. A mismatch appends an error, quarantines the raw bundle, and omits the index. The same retained inputs mint the same opaque refs. That replay does not reset raw-output proof and does not qualify selected-pin native capture.

Trusted live CapabilityCall fields are the package snapshot id, the runtime origin ref, and the runtime cache lineage ref, with trusted Workspace, Thread, Turn, AgentSession, and Agent lineage and a fresh request id. Those fields do not prove final provenance completeness. Usage and Audit rows join by `capabilityCallId`. They do not copy native identity. Reported input, output, cache, and USD figures are provider measurements. They are not origins inferred from cached tokens.

## Acceptance

L5/L6 packaged NanoCore and worker-shim qualification for the selected pin executes one governed Codex Task with at least two real sub-agents. That run preserves provenance and trusted inference and cache linkage. Default quota-free tests cannot substitute for that proof. A historical exec result cannot substitute for that proof. #775 remains the unmet qualification tracker.

An authorized reader can name the raw frames of one origin, its parent, and its children from the retained bundle. Product history remains one outer Turn. Raw native ids and raw cache keys stay off ordinary product surfaces.

## Implementation

- `apps/nanocore/src/runtime/`
- `apps/nanocore/src/llm/`
- `packages/worker-protocol/src/`
- `packages/worker-shim/src/`
- `packages/protocol/src/`
- `containers/worker-runtimes/`

## Implementation Gaps

- Complete `worker.runtime-provenance.v1` for the deployed Codex pin - NanoHost does not advertise the feature and the resident adapter refuses it - #775

## Decisions

None.
