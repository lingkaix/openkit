# Worker Runtime Sub-Agent Provenance And Inference Identity

Status: Accepted
Implementation: Not Started

## Owns

- The boundary between one NanoCore-owned worker execution and runtime-internal sub-agents created by Codex or another Worker Agent runtime.
- The raw runtime event capture and runtime-origin indexing contract needed to reconstruct parent and child activity without flattening native records into one ambiguous transcript.
- The trusted identity binding for worker-originated calls through `inference.local`.
- The separation between authoritative OpenKit lineage, runtime-native causal origin, and prompt-cache lineage.
- Product-safe runtime-origin and runtime-cache linkage from worker LLM calls into the existing `CapabilityCall` ledger.
- Completeness, quarantine, redaction, retention, and acceptance rules for runtime sub-agent provenance.

## Does Not Own

- The stable definitions of `Workspace`, `Thread`, `Turn`, `Item`, `Agent`, or `AgentSession`.
- Runtime-internal scheduling algorithms, prompts, tool selection, model behavior, or native sub-agent APIs.
- Core-owned delegation where NanoCore intentionally launches separate worker executions with independent scheduling, policy, budget, retry, recovery, or product-visible lifecycle.
- The general worker-control protocol, workspace synchronization protocol, public LLM Gateway API, provider capability matrix, or generic prompt-cache behavior for non-worker callers.
- A product-visible sub-agent graph, sub-agent management UI, `SubAgent` table, or a generic distributed tracing platform.
- Changes to the `EvidenceBundle` or `RuntimeEvidence` record shapes.

## Core References

- `docs/core/architecture.md`
- `docs/core/work-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-capability.md`
- `docs/core/storage.md`
- `docs/core/audit.md`
- `docs/product-vision.md`

## Summary

A large task may be assigned to one Worker Agent execution while Codex or another runtime creates many internal sub-agents. Those runtime children belong to the same OpenKit workspace, thread, turn, agent session, and Agent Environment Package snapshot, but they do not share one runtime-native thread or causal origin.

OpenKit must preserve both truths. The outer OpenKit lineage remains the authority for ownership, permissions, accounting, review, and product history, while a separate runtime-origin index preserves the native parent-child graph and maps each raw runtime frame to the correct internal origin. Runtime-native thread ids never become OpenKit `Thread` ids, and runtime-internal children never become Core `AgentSession` records merely because they exist.

Worker LLM calls require the same separation. An authenticated worker-inference binding supplies authoritative outer lineage, a runtime-origin hint identifies which internal runtime thread caused the call, and a separate runtime-cache lineage controls prompt-cache routing. Cache identity is performance metadata only; it never grants authority and never substitutes for causal provenance.

The implementation reuses the existing worker protocol, capability ledger, EvidenceBundle, and RuntimeEvidence surfaces. It adds only the minimum missing contracts: streamed raw runtime capture, a runtime-origin index, trusted worker-inference routing, one missing AEP snapshot lineage field, and two optional product-safe correlation refs on `CapabilityCall`.

## Goals / Non-goals

### Goals

- Make a parent runtime thread and any number of child runtime threads reconstructable from retained raw evidence.
- Ensure every retained raw runtime frame is either attributed to one runtime origin or explicitly marked unattributed, malformed, or truncated.
- Keep the canonical OpenKit turn coherent even when the runtime executes a private tree of sub-agents.
- Attribute worker LLM capability calls and usage to trusted outer lineage without trusting request-body metadata supplied by the runtime.
- Reconcile provisional live inference origin hints against the final normalized runtime-origin index before claiming complete attribution.
- Prevent sibling runtime threads from accidentally sharing one prompt-cache key merely because they share an OpenKit thread, turn, or agent session.
- Preserve intentional cache reuse when a runtime explicitly declares that two requests belong to the same cache lineage.
- Keep raw provider and runtime identifiers out of normal product APIs, audit rows, usage rows, logs, diagnostics, and default exports.
- Fail or quarantine provenance-incomplete worker output according to the AEP required-feature contract instead of silently claiming complete traceability.

### Non-goals

- Do not expose every runtime message, reasoning record, or sub-agent event as an OpenKit item.
- Do not create Core objects for runtime-internal children.
- Do not infer permissions, budgets, ownership, or review responsibility from runtime-native thread ids or prompt-cache keys.
- Do not build a provider-neutral trace query service before a concrete product need exists.
- Do not guarantee provider cache hits; OpenKit can preserve routing lineage and measure cache usage, but the upstream provider decides actual cache eligibility.
- Do not redesign EvidenceBundle, RuntimeEvidence, UsageRecord, or AuditEvent.

## Background

The current worker contract binds every worker transcript record to one outer lineage containing `workspaceId`, `threadId`, `turnId`, `agentSessionId`, `packageSnapshotId`, and an optional request id. This is correct for authority and product ownership, but it cannot distinguish multiple runtime-native threads inside that one worker execution.

The current Codex shim runs `codex exec --json`, buffers process stdout, discards successful JSON stdout after the process exits, and writes only normalized worker lifecycle events plus the final assistant message. The current NanoCore transcript importer therefore does not mix parent and child activity; it loses the native activity entirely. Flattening a future raw stream into the existing OpenKit JSONL files without an origin index would create the ambiguity this spec prevents.

Current Codex `exec --json` output is also not a complete multi-agent transcript. It emits the primary thread stream and collab tool items that carry sender and receiver thread ids, while child thread activity remains in separate runtime-native per-thread records such as Codex rollout JSONL. Capturing only exec stdout would preserve the spawn edges but still lose each child's raw turns, so complete provenance must collect a bounded set of reachable native streams rather than assume one process stream contains the whole runtime forest.

The vendored Codex app-server schemas already distinguish runtime-native thread ids, parent thread ids, depth, role or nickname metadata, and sub-agent activity. Those fields are useful evidence inputs, but they remain adapter-native and must not redefine the OpenKit work model.

The current public `POST /v1/chat/completions` and `POST /v1/responses` routes derive durable attribution only from caller-supplied `metadata.openkit`. Sandbox environment variables such as `OPENKIT_WORKSPACE_ID`, `OPENKIT_THREAD_ID`, `OPENKIT_TURN_ID`, and `OPENKIT_AGENT_SESSION_ID` are not automatically bound to those requests, so a worker using `inference.local` does not currently have a trusted path from its AEP session to the capability ledger.

The current prompt-cache resolver preserves an explicit `prompt_cache_key`, otherwise reads `metadata.openkit.promptCacheKey`, otherwise derives a key from stable OpenKit scope, and finally generates a request-scoped fallback. That generic behavior is suitable for public callers, but an outer OpenKit thread or agent session is too coarse for a runtime that has several concurrent child threads.

## Decision

OpenKit will model worker-internal sub-agent execution through three separate identity dimensions.

| Dimension | Purpose | Authority | Typical values | Persistence |
| --- | --- | --- | --- | --- |
| OpenKit worker lineage | Ownership, permission, review, accounting, scheduling, and product history | Authoritative after NanoCore validates the worker session binding | Workspace, thread, turn, agent session, package snapshot, request | Canonical records and ledgers |
| Runtime origin | Causal reconstruction inside one worker execution | Evidence only; never grants authority | Runtime family, native session, native thread, parent native thread, native turn, role, depth | Restricted raw evidence plus a product-safe normalized index |
| Runtime cache lineage | Stable routing for requests expected to share an exact prompt prefix | Performance hint only; never grants authority or proves causality | Runtime-provided cache lineage or an adapter-declared equivalent | Product-safe ref on `CapabilityCall`; raw value is not stored |

One runtime-internal parent and all of its runtime-internal children share the same OpenKit worker lineage. They normally have distinct runtime origins. They may have distinct or intentionally shared runtime cache lineage, depending on the runtime's declared cache semantics.

NanoCore will not create a `SubAgent` entity, a child `AgentSession`, a child OpenKit `Thread`, or a child OpenKit `Turn` for runtime-internal children. If a child needs independent permission, budget, scheduling, retry, recovery, review, or user-visible ownership, NanoCore must launch it as a separate bounded worker execution with its own Core lineage instead of treating it as a hidden runtime child.

## Contract / Expected Behavior

### 1. Outer Worker Lineage Remains Authoritative

- `WorkerLineageSchema` remains the authority-bearing worker lineage contract and remains unchanged by this design.
- All runtime-internal activity produced within one AEP snapshot MUST bind to the same expected `workspaceId`, `threadId`, `turnId`, `agentSessionId`, and `packageSnapshotId`.
- Runtime-native ids MUST NOT replace or override any OpenKit lineage field.
- A runtime-native parent-child relation MUST NOT imply an OpenKit handoff, delegation, new turn, new thread, or new agent session.
- Canonical items and artifacts remain owned by the outer OpenKit turn after NanoCore verification.

### 2. Runtime Provenance Capture

Sub-agent-capable runtime adapters MUST produce a bounded raw stream set plus two index files when the AEP requires `worker.runtime-provenance.v1`:

```text
/openkit/session/runtime/raw/
  stream-0000.jsonl
  stream-0001.jsonl
  ...
/openkit/session/runtime/raw-streams.json
/openkit/session/runtime/native-origin-index.jsonl
```

`raw/stream-0000.jsonl` is the byte-preserved primary runtime stream, such as `codex exec --json` stdout. The shim MUST stream this output to disk while the process runs and MUST NOT retain the complete stream in memory.

Additional `raw/stream-*.jsonl` files are byte-preserved runtime-native per-thread streams reachable from the primary runtime thread. For the first Codex adapter, these are the root and child rollout JSONL files selected by runtime-native thread metadata and spawn edges. The adapter MUST copy them under synthetic stream names so native ids and backend paths do not leak through product-safe filenames.

`raw-streams.json` is a restricted manifest that lists each synthetic stream ref, source kind, byte size, SHA-256 digest, physical frame count, capture status, and whether the stream reached a stable terminal boundary. It MUST identify the primary stream without embedding a native thread id in its product-safe locator.

`native-origin-index.jsonl` is an adapter-produced restricted index. Each line maps one physical raw frame in one manifest stream to runtime-native origin fields without rewriting the raw frame.

Each native origin index entry MUST contain:

- worker protocol schema version
- the full outer `WorkerLineage`
- runtime family and adapter version
- synthetic stream ref from `raw-streams.json`
- physical frame sequence
- UTF-8 byte offset and byte length in the referenced stream
- SHA-256 digest of the exact frame bytes
- normalized native event kind
- parse status: `parsed`, `unattributed`, `malformed`, or `truncated`
- runtime-native session id when available
- runtime-native thread id when available
- parent runtime-native thread id when available
- runtime-native turn id when available
- runtime role, nickname, and depth when available

Runtime-native ids in this file are restricted evidence. They MUST NOT be copied into canonical items, public App API records, MCP responses, usage records, audit rows, product logs, or normal diagnostics.

Every physical raw frame in every manifest stream MUST have exactly one index entry. A runtime-global event may be `unattributed` with no runtime thread id. An unknown event kind may remain `parsed` when frame boundaries and origin are still trustworthy. A malformed or truncated frame MUST remain represented and MUST NOT be silently assigned to the parent thread.

The adapter MUST discover child streams by traversing runtime-native spawn edges or parent-thread metadata from the primary runtime thread. It MUST NOT collect every file under a shared runtime home by timestamp or directory scan alone. A child referenced by the reachable graph but missing from the collected stream set, still running, or still changing at collection time makes provenance incomplete.

The raw stream set and native index MUST be bounded by AEP-declared byte and stream-count limits. Reaching either limit MUST close capture cleanly, mark remaining provenance `truncated`, and prevent the turn from being represented as provenance-complete.

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

NanoCore MUST mint product-safe opaque `runtimeOriginRef` values for runtime-native origins and `runtimeTurnRef` values when native turns are available. Minting MUST be deterministic for the same package snapshot, runtime family, and native origin so live inference calls and turn-end normalization converge on the same ref after retry or restart. NanoCore MUST create a normalized origin index that keeps outer lineage, synthetic stream refs, physical frame coordinates, product-safe origin refs, parent origin refs, normalized event kinds, role and depth summaries, and parse status while omitting every runtime-native id.

Runtime-origin refs attached to live worker-inference calls are provisional until turn-end provenance verification. Before promoting the normalized bundle, NanoCore MUST query every AEP-bound worker-inference `CapabilityCall` for the package snapshot and prove that each non-null `runtimeOriginRef` resolves to exactly one origin in the normalized index. A provenance-capable adapter MUST supply a non-null origin ref for each call it routes through the authenticated worker-inference path. A missing or unmatched ref makes gateway attribution incomplete, quarantines the normalized provenance result, and prevents the turn from claiming complete provenance; the durable capability call remains as an audit record and MUST NOT be silently rewritten to the root origin.

The normalized index MUST represent a forest because one worker execution may contain more than one runtime root. A frame with no trustworthy runtime origin remains explicitly unattributed.

Given a retained evidence bundle and one `runtimeOriginRef`, an authorized analyzer MUST be able to determine which raw frames belong to that origin, its parent origin, its child origins, and the shared outer OpenKit lineage. The analyzer MUST NOT need to reinterpret all records as one OpenKit transcript.

NanoCore MUST NOT translate raw runtime child messages into canonical OpenKit items by default. The adapter may continue producing bounded product-safe progress summaries and the final outer result through existing worker transcript records. Raw runtime events remain evidence.

### 4. Evidence And Retention Projection

This design reuses the existing record shapes without modifying `EvidenceBundle` or `RuntimeEvidence`.

After successful verification, NanoCore MUST automatically create two workspace-owned EvidenceBundle records because restricted raw streams and the product-safe normalized index have different retention and export rules.

The restricted raw bundle MUST contain:

- `sourceKind: "worker-runtime-provenance-raw"`
- the outer workspace, thread, turn, and agent-session lineage
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

NanoCore MUST also write or extend the existing transcript-collection RuntimeEvidence producer so its product-safe summary reports capture completeness, raw stream count, raw frame count, attributed frame count, unattributed frame count, runtime root count, child origin count, AEP-bound worker-inference call count, origin-reconciled call count, gateway-attribution completeness, and both EvidenceBundle ids. The existing RuntimeEvidence shape and `evidenceBundleIds` linkage are sufficient.

Malformed lineage, missing reachable streams, unstable child streams, digest mismatch, invalid frame mapping, cycles, unsupported required features, or prohibited raw identifiers in the normalized index MUST quarantine the restricted raw bundle, prevent promotion of the normalized bundle, and prevent claims of complete provenance.

The raw stream manifest, raw streams, native index, and their locators MUST NOT be returned by normal App API, Core Client, MCP, Web, audit, usage, or diagnostics surfaces. The internally stored restricted bundle retains its governed raw refs, but the existing read-only EvidenceBundle projection MUST return that bundle with `rawEvidenceRefs: []`; its product-safe lineage, summary, digests, retention, sensitivity, import status, and required features remain visible. Default workspace export MUST retain the product-safe normalized bundle. When restricted raw export is not explicitly authorized, export MUST retain only an expired raw-bundle index with content digests and empty raw refs so RuntimeEvidence linkage does not dangle; it MUST NOT include restricted raw files or locators.

Manual EvidenceBundle creation is not part of this flow. Both worker runtime provenance bundles are produced only by the NanoCore transcript-collection boundary.

### 5. Trusted Worker Inference Binding

The sandbox-visible LLM endpoints remain:

```text
https://inference.local/v1/chat/completions
https://inference.local/v1/responses
```

The backend relay MUST map those sandbox-visible requests to authenticated NanoCore worker-inference routes rather than treating them as ordinary unattributed public Gateway calls. The target NanoCore routes are:

```text
POST /api/worker-inference/v1/chat/completions
POST /api/worker-inference/v1/responses
```

These routes MUST preserve OpenAI-compatible request and response bodies, streaming SSE, client cancellation, `prompt_cache_retention`, and supported request compression or decompression semantics required by the pinned runtime adapter, but they are an internal worker capability surface and not a second public LLM API.

The worker-inference routes MUST authenticate a short-lived sandbox session binding that resolves server-side to the registered package snapshot, active lease, workspace, thread, turn, agent, agent session, allowed provider selection, and allowed model selection. The implementation SHOULD reuse the existing worker-control session token and durable lease binding instead of creating a second worker identity store.

Worker-supplied authorization headers MUST be stripped at the sandbox relay boundary. Request-body `metadata.openkit` and arbitrary worker headers MUST NOT establish or override authority-bearing lineage. Conflicting OpenKit authority fields MUST fail with `worker_inference_lineage_mismatch`.

An authenticated worker inference call without a valid active AEP and lease binding MUST fail closed with `worker_inference_unauthorized`. A backend that cannot preserve the binding MUST route through an OpenKit-owned inference relay or fail AEP capability negotiation before worker launch.

The selected relay MUST prove before launch that it can inject the trusted session binding, preserve allowlisted runtime session/thread/sub-agent hints, strip sandbox-supplied authority and credential headers, and carry streaming responses and cancellation. A nominal `inference.local` endpoint without those properties does not satisfy this contract.

When an AEP requires complete worker-inference attribution, the runtime adapter MUST configure the root runtime and every runtime-internal child to use `inference.local`, and the backend policy MUST withhold direct provider credentials and deny direct provider API egress. If the runtime or backend cannot prove that coverage, capability negotiation MUST fail before launch. An AEP that does not require this relay may still produce runtime provenance, but OpenKit MUST report gateway attribution as incomplete and MUST NOT claim that every worker LLM call was captured.

The existing public `/v1/chat/completions` and `/v1/responses` routes remain generic public Gateway routes. Their caller-supplied metadata may support best-effort public attribution, but it is not accepted as worker authority.

### 6. Runtime Call Origin

Each runtime adapter that declares `worker.runtime-provenance.v1` MUST define a pinned, allowlisted mapping from its native inference request fields to an internal `WorkerInferenceRuntimeHint` containing:

- runtime family
- runtime-native session id when available
- runtime-native thread id
- runtime-native turn id when available
- parent runtime-native thread id when available
- runtime-native inherited-context signal when available
- runtime-native cache lineage id when available

The relay MUST remove runtime-native hint fields before sending the request upstream. NanoCore MUST resolve the native thread hint to the same product-safe `runtimeOriginRef` used by the normalized provenance index, treat the live mapping as provisional, and reconcile it at turn end as defined above.

Runtime hints are causal and performance inputs only. They MUST NOT alter workspace, thread, turn, agent-session, package, provider, model, permission, vault, budget, or policy ownership.

A sub-agent-capable adapter that cannot supply a stable runtime thread hint MUST NOT declare complete runtime provenance. When the AEP requires complete provenance, capability negotiation or the worker turn MUST fail rather than silently attributing every inference call to the outer root.

### 7. Prompt-Cache Lineage

The worker inference path MUST treat runtime cache lineage as separate from both outer OpenKit lineage and runtime causal origin.

For an authenticated worker request, the pinned adapter resolves cache lineage in this order and passes only the resulting semantic decision to the Gateway:

1. A runtime-declared inherited cache lineage when an explicit native inherited-context signal and a verified parent origin are both available.
2. An explicit runtime `prompt_cache_key` or another adapter-declared native cache lineage field with equivalent semantics.
3. A request-scoped generated fallback when no declared runtime cache lineage exists.

The worker path MUST NOT derive a shared cache key solely from the outer OpenKit `threadId`, `turnId`, or `agentSessionId`. Those values are shared by all runtime-internal children and would collapse unrelated child cache routing.

The worker path MUST NOT forward or store the raw runtime cache lineage value. It MUST derive the upstream `prompt_cache_key` from a stable hash over at least the provider instance, provider account slot when applicable, model, workspace, runtime family, and runtime cache lineage value. The raw lineage value and the resulting upstream key MUST remain absent from capability rows, usage rows, audit rows, diagnostics, logs, and product APIs.

The Gateway MUST also mint a distinct product-safe `runtimeCacheLineageRef` for analysis. Equality of this ref means only that OpenKit intentionally routed the calls under the same cache lineage; it does not prove a cache hit or causal parentage.

If a runtime gives a child a distinct cache lineage, the child receives a distinct upstream key. If a runtime explicitly reports that a child inherited the parent prefix and cache lineage, OpenKit preserves that equality while keeping `runtimeOriginRef` distinct. A parent-child relation by itself is not enough to infer cache inheritance, and OpenKit MUST NOT guess shared cache lineage from provenance alone. Actual cache hits still depend on provider-specific prefix and routing behavior.

When no runtime cache lineage is available, the Gateway MUST use a request-scoped key, leave `runtimeCacheLineageRef` null, and record a product-safe degraded-cache diagnostic. It MUST prefer lost reuse over accidental sibling sharing.

### 8. Capability, Usage, And Audit Linkage

`CapabilityCall` will gain one optional nullable outer-lineage field and two optional nullable product-safe correlation fields:

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
- Restart recovery MAY re-run verification from the retained stream manifest, raw streams, and native index, but it MUST produce the same normalized origin refs and bundle digests for the same retained inputs.

## Proposed Design

```text
OpenKit Turn / AgentSession / AEP snapshot
  -> governed worker runtime
      -> main runtime thread
          -> child runtime thread A
          -> child runtime thread B
      -> streamed primary raw stream
      -> bounded reachable child stream snapshots
      -> restricted raw-streams.json
      -> restricted native-origin-index.jsonl
  -> NanoCore verification
      -> normalized runtime-origin index
      -> automatic restricted-raw EvidenceBundle
      -> automatic turn-evidence EvidenceBundle
      -> existing RuntimeEvidence transcript-collection record
      -> canonical outer items and artifacts only

runtime LLM request
  -> inference.local
  -> authenticated worker-inference binding
  -> trusted outer OpenKit lineage
  -> adapter-mapped runtime origin
  -> separate runtime cache lineage
  -> shared LLM dispatcher and capability ledger
```

The runtime adapter owns native parsing and hint mapping. NanoCore owns authentication, verification, product-safe reference minting, evidence promotion, capability attribution, and canonical product records. The LLM dispatcher remains shared; the new worker route supplies a stronger call context rather than creating another provider stack.

## Current Implementation Projection

Current code does not yet satisfy this contract.

- `packages/worker-protocol/src/index.ts` defines only outer `WorkerLineage` for worker records and has no runtime-native provenance schemas.
- `packages/worker-shim/src/cli.ts` invokes Codex with JSON output, buffers stdout and stderr in memory, does not retain successful primary JSON stdout, does not collect reachable per-thread rollout streams, and writes only the final assistant message plus worker lifecycle records.
- `apps/nanocore/src/runtime/worker-transcript.ts` validates only outer package lineage and imports assistant messages and artifacts without runtime-origin linkage.
- `apps/nanocore/src/runtime/worker-governance-backend.ts` collects the existing transcript files and injects outer OpenKit lineage into the sandbox environment, but it does not collect a raw stream manifest, root/child stream set, or native origin index.
- Current Codex exec JSONL exposes a primary `thread.started` id and collab tool calls with sender and receiver thread ids, but its event filter does not emit complete child-thread event streams; current Codex per-thread rollout records and vendored app-server parent-thread fields are therefore both relevant adapter inputs.
- `packages/codex-app-server-schema/generated-schema/v2/ThreadReadResponse.json` and `ItemStartedNotification.json` expose native parent-thread and sub-agent fields that can validate the pinned Codex adapter's normalized graph.
- `apps/nanocore/src/app.ts` public LLM routes read durable attribution from request-body `metadata.openkit` and do not authenticate a worker AEP binding.
- `apps/nanocore/src/llm/prompt-cache-key.ts` preserves explicit keys and otherwise derives stable keys from generic OpenKit metadata or scope, with no worker-specific runtime cache lineage.
- `apps/nanocore/src/capability/usage-ledger.ts` has one shared capability ledger but no runtime-origin or runtime-cache lineage fields.
- The current EvidenceBundle read and workspace-export projections preserve stored `rawEvidenceRefs`; they must gain a restricted product projection before runtime-native raw refs can be stored safely.
- Existing EvidenceBundle and RuntimeEvidence records already provide the required automatic evidence indexes, distinct `restricted-raw` and `turn-evidence` retention, transcript-collection phase, digest, and cross-record linkage shapes; their schemas do not need redesign.

## Alternatives Considered

### Promote every runtime child to Core AgentSession, Thread, or Turn

Rejected. Runtime-internal children do not independently own product scheduling, permission, review, recovery, or user-visible history. Promotion would leak provider implementation details into the Core model and create large amounts of lifecycle state with no current product owner.

### Flatten all runtime-native events into existing worker transcript JSONL

Rejected. Outer lineage alone cannot distinguish concurrent native threads, and native event order is not the canonical OpenKit item order.

### Store only the final assistant answer

Rejected as the target. It keeps the product transcript simple but loses the evidence needed to explain which runtime child performed work, diagnose failures, or attribute inference usage.

### Use the outer OpenKit thread id as the worker prompt-cache key

Rejected. Runtime-internal siblings share the outer thread while their prompts and cache lineages may diverge.

### Trust `metadata.openkit` supplied by the worker

Rejected. Worker-supplied metadata is not a trusted binding to the active AEP, lease, workspace, provider, or budget context.

### Add a generic trace platform or universal actor graph

Rejected. Two concrete needs do not justify a new framework. A bounded raw stream set, one manifest, one origin index, authenticated worker inference, and two capability refs are sufficient.

## Consequences

- OpenKit can preserve a simple user-facing turn while retaining enough evidence to reconstruct a complex runtime execution tree.
- Runtime adapters must understand and test their native sub-agent event and inference hint shapes.
- Raw runtime evidence will consume bounded storage and requires explicit retention and access control.
- The worker inference path becomes a distinct authenticated projection over the existing LLM dispatcher, while the public Gateway routes remain unchanged.
- Capability-call storage and public read schemas gain one nullable AEP snapshot field plus two nullable correlation fields, but UsageRecord and AuditEvent remain unchanged.
- Cache routing becomes measurable by runtime lineage without conflating cache identity with permissions or product ownership.

## Rollout / Migration Plan

OpenKit is in internal development, so the clean target replaces the incomplete worker path without compatibility aliases.

1. Add failing worker-protocol, worker-shim, NanoCore import, evidence, Gateway identity, capability ledger, and prompt-cache tests.
2. Add runtime provenance output declarations and required-feature negotiation to AEP resolution.
3. Stream primary Codex JSON output, discover the reachable child graph, snapshot each stable child rollout under a synthetic stream ref, and generate the restricted stream manifest and native origin index from pinned fixtures and schema evidence.
4. Collect, verify, normalize, retain, and automatically index runtime provenance through separate restricted-raw and product-safe EvidenceBundle producers plus the existing RuntimeEvidence producer.
5. Add the authenticated worker-inference routes and relay binding while sharing the existing provider dispatcher and usage recorder.
6. Add `packageSnapshotId`, `runtimeOriginRef`, and `runtimeCacheLineageRef` to `CapabilityCall`, its storage row, export/import projection, App API read schema, and generated OpenAPI.
7. Switch sub-agent-capable worker AEPs to require `worker.runtime-provenance.v1` only after the adapter, relay, and importer pass conformance tests.
8. Remove any temporary code that buffers complete Codex stdout, trusts worker `metadata.openkit` for authority, or derives a worker cache key solely from outer lineage.

Existing internal worker records are not backfilled. A provenance-capable retry creates a new package snapshot and new evidence rather than pretending historical raw data exists.

## Testing Strategy / Acceptance Criteria

Testing follows `docs/specs/20260529-test_strategy.md`.

### L0: Static And Schema Checks

- Worker protocol schemas accept valid runtime provenance entries and reject missing lineage, invalid frame ranges, negative depth, and unsupported required features.
- Protocol and App API schemas accept nullable product-safe runtime refs and reject raw native ids in public records.
- Leak checks reject raw runtime thread ids, raw cache keys, prompts, authorization headers, and provider payloads from public rows and generated API examples.

### L1: Unit Tests

- The Codex adapter maps the primary exec stream, collab spawn edges, root and child rollout streams, parent links, role, depth, and frame coordinates from pinned fixtures.
- Raw capture preserves exact bytes, uses bounded streaming for primary stdout and bounded stream copying for child rollouts, and never loads the complete stream set in memory.
- The importer detects missing manifest streams, unlisted streams, missing reachable children, unstable children, missing frames, digest mismatch, range overlap, parent cycles, malformed lines, truncation, and lineage mismatch.
- The importer rejects an index whose declared origin, parent, turn, role, depth, or event kind disagrees with the corresponding pinned raw frame.
- Runtime-origin ref minting is deterministic for the same registered session and native origin while remaining opaque in product-safe output.
- Worker cache derivation is stable for one runtime cache lineage, differs for distinct child lineages, preserves intentional shared lineage, includes provider/account/model/workspace isolation, and falls back to a request-scoped key when absent.
- Worker request ids are unique per inference call even when all calls share one outer AEP request id.

### L2: Contract And Conformance Tests

- A fixture containing one primary exec stream plus separate parent, child A, and child B rollout streams reconstructs the exact runtime forest and returns the correct raw frame set for each `runtimeOriginRef`.
- Canonical item import remains one coherent outer turn and does not flatten child messages into product history.
- Spoofed `metadata.openkit`, runtime headers, package snapshot ids, and inactive lease bindings fail closed.
- Public `/v1` routes retain their generic contract, while worker-inference routes use authenticated lineage and the same provider dispatcher and preserve streaming, cancellation, retention, and supported compression semantics.
- A relay-required AEP routes root and child inference through `inference.local`, blocks direct provider credentials and egress, and fails capability negotiation when the backend cannot prove that coverage.
- Capability calls contain trusted outer lineage plus product-safe runtime refs, and linked usage/audit rows require no duplicate runtime fields.
- Turn-end reconciliation rejects a missing or unknown capability-call `runtimeOriginRef` instead of assigning it to the root origin.

### L3: NanoCore Black-Box Tests

- A fake governed worker emits a primary stream plus separate root and child streams, makes LLM calls from each origin, completes one outer turn, and produces one promoted restricted-raw bundle, one promoted product-safe index bundle, one transcript-collection RuntimeEvidence record, canonical outer items, capability calls, usage rows, and audit linkage.
- Distinct child cache lineages produce distinct upstream cache keys and refs even though the calls share the same OpenKit thread, turn, and agent session.
- An explicitly declared inherited cache lineage produces the same upstream cache key and ref while runtime origins remain distinct, while parentage without an inheritance signal remains isolated.
- Missing or tampered required provenance quarantines evidence and prevents a successful provenance-complete terminal result.
- A capability call whose provisional runtime origin is absent from the final normalized forest prevents gateway-attribution completeness while preserving the failed call as an audit record.
- Normal EvidenceBundle reads expose the restricted bundle index with empty `rawEvidenceRefs`, and no raw locator appears in App API, Core Client, MCP, Web, diagnostics, or default export output.
- Default workspace export preserves the promoted product-safe index bundle, rewrites an omitted restricted raw bundle to an expired digest-only index with no raw refs, and omits restricted raw files and locators.

### L5 And L6

- Packaged NanoCore and the worker shim complete one governed Codex task that spawns at least two sub-agents without losing or flattening native provenance.
- A skip-aware real Codex story verifies the parent-child runtime tree, outer turn coherence, trusted worker Gateway attribution, distinct or intentionally shared cache lineage, and cached-token telemetry without exposing native ids or consuming provider quota in default test runs.

Acceptance is complete only when all of the following are true:

- An authorized analyst can reconstruct which raw frames across the bounded native stream set belong to each runtime origin and how the origins are parented.
- Product consumers still see one correct outer OpenKit turn unless NanoCore intentionally scheduled separate worker executions.
- Every worker LLM call in an AEP that requires complete worker-inference attribution is forced through the authenticated relay, bound to the AEP rather than request-body metadata, and reconciled to the final runtime-origin index.
- Sibling runtime origins do not share a cache key solely because they share outer lineage.
- Intentional runtime cache lineage sharing remains possible and measurable.
- Raw runtime ids and raw cache keys never appear in normal product surfaces.
- EvidenceBundle and RuntimeEvidence shapes remain unchanged, the normalized index remains resolvable after restricted raw expiry, and all provenance bundles are written only by automatic NanoCore producers.

## Risks & Mitigations

- Risk: Raw runtime streams contain sensitive prompts, code, tool output, or provider metadata. Mitigation: keep them restricted, bounded, access-controlled, excluded from normal APIs and default exports, and subject to `restricted-raw` retention.
- Risk: Exec JSONL, rollout JSONL, or app-server schema drift breaks origin parsing. Mitigation: pin adapter versions and fixtures, advertise required features, preserve raw bytes, and quarantine unsupported mappings instead of guessing.
- Risk: Provenance indexing adds memory pressure for large tasks. Mitigation: stream primary bytes, copy child streams incrementally, and write index lines with bounded buffers and backpressure.
- Risk: Runtime-native ids leak into product records. Mitigation: mint opaque refs in NanoCore and run canary leak checks across evidence summaries, capability rows, usage rows, audit rows, API responses, logs, and exports.
- Risk: An authenticated worker spoofs another child origin within its own session. Mitigation: treat runtime origin as evidence rather than authority, validate it against the retained native stream, and never use it for permissions or provider selection.
- Risk: A runtime bypasses `inference.local`, so Gateway records appear complete while direct provider calls are missing. Mitigation: require root-and-child relay configuration, withhold direct provider credentials, deny direct provider egress, and fail capability negotiation when coverage cannot be proved.
- Risk: Shared cache lineage becomes a hot routing key. Mitigation: preserve runtime intent, measure request fanout and cached-token effectiveness by product-safe cache lineage, and allow the adapter to rotate lineage when its native runtime does so.
- Risk: A backend cannot inject a trusted inference binding. Mitigation: use an OpenKit-owned relay or fail AEP capability negotiation before launch.

## Open Questions

None. The accepted V1 contract deliberately leaves provider-specific header names, opaque ref minting implementation, and privileged forensic export UX presentation to implementation while fixing their required semantics and security boundaries.

## Deferred / Future Work

- Product-visible runtime execution visualization when a real user workflow requires it.
- Cross-turn runtime-origin continuity for runtimes that support durable native session resume.
- Provider-neutral tracing or OpenTelemetry export after the normalized index proves useful in production.
- Runtime-origin-aware artifact and item projections if users need to inspect which internal child produced a promoted deliverable.
- Cache-lineage rate-limit controls after measured fanout and provider behavior justify policy.
- OpenKit-side cache inheritance for runtimes that expose only parentage but no trustworthy inherited-context signal; V1 records the cache loss instead of guessing.

## Links

- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260704-capability_usage_gateway_foundation.md`
- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/changes/202607111937290001-worker_runtime_subagent_provenance.md`
- [Codex exec JSONL event model](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs)
- [Codex exec JSONL projection](https://github.com/openai/codex/blob/main/codex-rs/exec/src/event_processor_with_jsonl_output.rs)
- [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
