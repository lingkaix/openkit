# Worker Runtime Sub-Agent Provenance And Gateway Identity

Type: change-plan
Status: verified

## Intent

Implement the accepted worker-runtime sub-agent provenance contract so one NanoCore-owned worker turn can safely contain many runtime-native parent and child threads without losing raw causal structure, corrupting canonical product history, or collapsing sibling prompt-cache routing.

The same change will close the current worker LLM Gateway identity gap by adding an authenticated AEP-bound worker inference path, product-safe runtime origin and cache correlation on `CapabilityCall`, and worker-specific prompt-cache derivation that never trusts request-body OpenKit metadata as authority.

## Scope

- Add worker protocol records for byte-addressed raw runtime frame provenance and runtime-native origin indexing while keeping `WorkerLineageSchema` unchanged.
- Extend AEP transcript and backend-required-feature projections for `worker.runtime-provenance.v1`, raw runtime stream-set paths, byte and stream-count limits, and trusted worker inference relay support.
- Change the Codex worker shim from whole-process stdout buffering to bounded primary streaming plus reachable child-rollout collection, generate a restricted stream manifest and native origin index, and preserve the final normalized outer assistant result.
- Collect, verify, normalize, quarantine, retain, and summarize runtime provenance in NanoCore.
- Automatically create one restricted-raw provenance EvidenceBundle, one product-safe turn-evidence index bundle, and one new transcript-collection RuntimeEvidence record without changing any record shape.
- Add authenticated internal worker-inference routes reached through an OpenKit-owned, OpenShell-governed provider-placeholder path and bind each request to the registered AEP snapshot and active worker lease.
- Add worker-specific runtime origin and cache lineage resolution without changing the generic public `/v1/chat/completions` and `/v1/responses` contract.
- Add optional nullable `packageSnapshotId`, `runtimeOriginRef`, and `runtimeCacheLineageRef` fields to `CapabilityCall`, durable storage, export/import, App API readback, generated OpenAPI, and first-party client parsing.
- Add cached-token and cache-lineage conformance coverage that proves siblings are isolated by default and intentional cache lineage sharing remains possible.
- Update package guides, active specs, generated contracts, and test stories after implementation lands.

## Non-Goals

- Do not create a Core `SubAgent` entity, runtime-child table, child OpenKit thread, child OpenKit turn, or child AgentSession for runtime-internal sub-agents.
- Do not expose raw runtime events, native thread ids, native session ids, raw prompt-cache keys, prompts, reasoning payloads, or provider payloads through normal App API, Core Client, MCP, Web, audit, usage, diagnostics, logs, or default workspace exports.
- Do not add a sub-agent UI, runtime tree management API, generic tracing platform, event bus, actor framework, or OpenTelemetry exporter.
- Do not redesign or extend the `EvidenceBundle`, `RuntimeEvidence`, `UsageRecord`, or `AuditEvent` schemas.
- Do not reintroduce manual EvidenceBundle creation or `WorkspaceSyncEvidenceBundle` while implementing automatic runtime provenance production.
- Do not merge this plan into [Evidence Surface Simplification](./202607111848520001-evidence_surface_simplification.md). The two plans remain independently executable and must preserve each other's boundaries.
- Do not change provider-specific cache eligibility or promise cache hits; only preserve and measure routing lineage.
- Do not infer inherited cache lineage from parentage alone when the runtime supplies no trustworthy inherited-context signal.
- Do not preserve compatibility readers, aliases, fallback routes, or old internal storage shapes.

## Related Context

- [Architecture](../core/architecture.md)
- [Work Model](../core/work-model.md)
- [Agent Session](../core/agent-session.md)
- [Agent Capability](../core/agent-capability.md)
- [Storage](../core/storage.md)
- [Audit](../core/audit.md)
- [Product Vision](../product-vision.md)
- [Worker Runtime Sub-Agent Provenance And Inference Identity](../specs/20260711-worker_runtime_subagent_provenance.md)
- [Agent Environment Package And Worker Governance Backends](../specs/20260616-agent_environment_package.md)
- [OpenShell Disposable Cell Lifecycle](../specs/20260715-openshell_disposable_cell_lifecycle.md)
- [Worker Runtime Communication Model](../specs/20260629-worker_runtime_communication_model.md)
- [Worker Control Protocol](../specs/20260703-worker_control_protocol.md)
- [Worker Agent Capability](../specs/20260703-worker_agent_capability.md)
- [Capability Usage Gateway Foundation](../specs/20260704-capability_usage_gateway_foundation.md)
- [LLM Gateway Responses API](../specs/20260526-llm_gateway_responses_api.md)
- [Audit, Usage, And Evidence Records](../specs/20260703-audit_usage_evidence_records.md)
- [Storage Layout And Record Ownership](../specs/20260703-storage_layout_record_ownership.md)
- [Schema Evolution And Record Envelope](../specs/20260703-schema_evolution_record_envelope.md)
- [Test Strategy](../specs/20260529-test_strategy.md)
- [Evidence Surface Simplification](./202607111848520001-evidence_surface_simplification.md)

## Accepted Target

The implementation must preserve three separate identities.

| Identity | Owner | Used for | Must not be used for |
| --- | --- | --- | --- |
| OpenKit worker lineage | NanoCore and the registered AEP session | Authority, permissions, provider selection, budgets, accounting, review, product history | Distinguishing runtime-internal children or deriving one shared worker cache key |
| Runtime origin | Runtime adapter as evidence input, normalized by NanoCore | Parent-child reconstruction and causal correlation | Permission, scheduling, product ownership, or provider selection |
| Runtime cache lineage | Runtime adapter as a performance hint, normalized by NanoCore | Stable upstream prompt-cache routing and cache effectiveness analysis | Authority, causal parentage, canonical thread identity, or item ordering |

One outer worker turn may contain a runtime forest. NanoCore keeps one canonical outer turn, retains raw native activity as restricted evidence, creates a product-safe runtime-origin index, and links worker LLM capability calls to the correct runtime origin and cache lineage.

## Phase 1 Landing Decision

### Landing Judgment

Shrink the first move while keeping the accepted target. Stock OpenShell `inference.local` cannot carry a per-AEP identity or the runtime hints required by this contract, so implementation must first prove an authenticated OpenKit worker-inference path before provenance capture or public correlation fields are enabled.

### Bold Direction Kept

One governed outer worker turn still retains a complete bounded runtime forest, routes every required worker inference call through NanoCore, separates causal origin from cache lineage, and produces only product-safe correlations outside restricted evidence.

### Reality Check

- Real constraints: OpenShell 0.0.80 is the repository-pinned boundary, its reserved `inference.local` route is gateway-global and strips non-allowlisted identity headers, the worker image and vendored schema are aligned on Codex 0.144.1, relay-required packages now have a fail-closed provider and egress materialization path, and ordinary packages continue to use the legacy direct ChatGPT path until the authenticated relay transport is executable and enabled.
- Unproven assumptions: the explicit OpenShell REST policy and provider-placeholder path must preserve Codex Responses streaming, cancellation, supported compression, `x-client-request-id`, sub-agent hints, and credential rewriting against the pinned runtime.
- Highest blast radius: changing worker inference routing can strand all governed Codex execution or falsely claim complete attribution while direct calls still bypass NanoCore.
- Most inflated part: implementing the full provenance importer, evidence lifecycle, capability ledger, and export/import changes before the authenticated relay path is executable would create records whose completeness claim cannot be trusted.

### Minimum Viable Move

- Do this first: land one test-first vertical relay slice from AEP declaration and generated Codex provider configuration through OpenShell host, method, path, and binary policy to token-only WorkerControlGateway authentication and the existing NanoCore provider dispatcher.
- Scope: use a per-package OpenShell provider placeholder for the short-lived worker-control token, point Codex 0.144.1 at `/api/worker-inference/v1`, strip authority overrides, remove direct provider credentials and egress for relay-required packages, and prove both Responses and Chat Completions transport behavior.
- Explicitly not doing: do not enable `worker.runtime-provenance.v1`, add runtime-origin product fields, or promote provenance bundles until this slice passes deterministic conformance and the opt-in pinned OpenShell probe.
- Why this move: it creates the first trustworthy proof that every later origin, cache, usage, and evidence record is observing the real worker inference path rather than a bypassable approximation.

### Verification

- Success criteria: valid active package and lease tokens reach the selected AEP provider and model; spoofed lineage and credentials fail; direct provider egress is absent; distinct requests stay distinct; SSE, cancellation, allowed compression, and runtime hints survive; the public Gateway remains unchanged.
- Failure signals: a gateway-global identity, stripped runtime hints, a provider credential inside the sandbox, any permitted direct provider route, lost cancellation, unsupported compressed bodies, or a worker request that can select different authority or provider context.
- Cheapest check: package contract tests plus a deterministic OpenShell policy/provider command probe and NanoCore route tests with a fake dispatcher.
- Required before scaling: the repository-pinned OpenShell 0.0.80 and Codex 0.144.1 combination must pass the opt-in executable relay probe before the AEP may require complete provenance.

### Cut List

- Do not use OpenShell's reserved `inference.local` for complete AEP attribution.
- Do not add a second identity store, provider stack, generic relay framework, public worker-inference API, runtime-child entity, or compatibility route.
- Do not implement raw retention deletion, forensic export UX, boot-wide provenance scans, or cross-turn runtime continuity in the first slice.

### Stop Rule

Stop the rollout with trusted worker inference disabled if OpenShell 0.0.80 cannot resolve the per-package placeholder on the exact REST rules while preserving streaming, cancellation, compression, and runtime hints; do not weaken identity or direct-egress invariants and do not add a sidecar fallback.

### Next Move

Correct the owning spec and this execution plan, then add the failing package and relay-contract tests without changing runtime behavior in the same commit.

## Required Invariants

- `WorkerLineageSchema` remains unchanged and every runtime frame stays bound to the registered outer package snapshot.
- Every retained raw frame across the manifest stream set has exactly one physical index entry and is either attributed to one runtime origin or explicitly marked unattributed, malformed, or truncated.
- Primary runtime output is streamed with backpressure, child streams are copied incrementally, and the declared byte and stream-count limits prevent the complete provenance set from being buffered in memory.
- Complete Codex provenance includes the primary exec stream and every stable per-thread rollout reachable through native spawn edges or parent metadata; root stdout alone is insufficient.
- NanoCore re-parses pinned structural fields from each raw frame and rejects adapter index claims that disagree with the retained bytes.
- Native ids remain restricted evidence and never become OpenKit ids or public record fields.
- The normalized runtime-origin index contains only opaque product-safe refs, outer lineage, frame coordinates, parent refs, normalized event kinds, role/depth summaries, parse status, and digests.
- Runtime-internal children do not create Core objects unless NanoCore separately schedules them as independent worker executions.
- Runtime-native sub-agent messages are not flattened into the canonical item log by default.
- Runtime provenance EvidenceBundle creation is automatic and uses separate existing `restricted-raw` and `turn-evidence` retention classes; a new producer uses the existing RuntimeEvidence transcript-collection phase and `evidenceBundleIds` linkage.
- Ordinary EvidenceBundle reads expose the restricted runtime provenance bundle with empty raw refs, while default exports retain it only as an expired source-digest row with product-safe lineage, digests, retention, sensitivity, status, and required-feature metadata; other automatically produced bundle projections remain unchanged.
- Worker inference authority comes only from an authenticated active AEP and lease binding.
- Worker `metadata.openkit` and arbitrary headers cannot establish or override workspace, thread, turn, agent-session, package, provider, model, permission, budget, or policy context.
- Each worker inference call gets a unique capability request id even when all calls share one outer AEP request id.
- Every provisional `runtimeOriginRef` on an AEP-bound worker-inference call is reconciled to exactly one origin in the final normalized index before complete attribution is claimed.
- Worker cache derivation never falls back to a shared outer thread, turn, or agent-session scope.
- Raw runtime cache lineage and derived upstream prompt-cache keys are never stored in product records.
- `packageSnapshotId`, `runtimeOriginRef`, and `runtimeCacheLineageRef` live on `CapabilityCall`; linked UsageRecord and AuditEvent rows do not duplicate them.
- The public LLM Gateway routes remain generic, while a per-package OpenShell provider placeholder and explicit REST policy route the worker to authenticated internal worker-inference routes over the same provider dispatcher.
- The selected inference relay proves trusted binding injection plus streaming, cancellation, runtime-hint forwarding, credential stripping, and supported request compression before worker launch.
- A relay-required AEP forces root and child inference through the authenticated OpenKit route, withholds direct provider credentials, and blocks direct provider API egress; inability to prove that coverage fails capability negotiation.
- Missing required provenance, identity binding, unsupported adapter features, lineage mismatch, digest mismatch, invalid frame mapping, or parent cycles fail or quarantine without silent degradation.
- This implementation must not recreate either evidence surface scheduled for removal by the evidence simplification plan.

## Impacted Surfaces

### Worker Protocol And AEP Contracts

- `packages/worker-protocol/src/index.ts` and tests: add the restricted raw stream manifest, native origin index entry, parse status, stream/frame coordinate, runtime-native origin, and required-feature schemas. Keep outer lineage and existing transcript record semantics unchanged.
- `packages/config-schema` AEP schemas, resolver fixtures, and generated types: declare the raw stream directory, manifest and index paths, provenance byte and stream-count limits, required feature `worker.runtime-provenance.v1`, and trusted inference relay capability without leaking backend-native ids.
- `docs/specs/20260616-agent_environment_package.md` implementation projection and package examples: mark the extension implemented only after these schema and resolver paths land.

### Worker Shim And Codex Adapter

- `packages/worker-shim/src/cli.ts`: replace whole-process stdout accumulation for Codex with a bounded streaming sink and keep stderr diagnostics bounded and redacted.
- Add one focused Codex provenance adapter module if extraction keeps the process supervisor cohesive; do not create a generic adapter framework or extra package.
- Parse pinned primary exec and per-thread rollout fixtures into stream manifest and native origin index entries using runtime-native spawn edges, rollout metadata, and the repository's vendored Codex schema evidence where applicable.
- `containers/worker-codex/Dockerfile`, `packages/codex-app-server-schema`, pinned fixtures, and the adapter capability declaration: align on Codex 0.144.1 before claiming parser support.
- Discover only the runtime forest reachable from the primary `thread.started` id, snapshot stable child streams under synthetic names, and fail completeness when a referenced child is missing, still running, or still changing.
- Preserve exact primary and child bytes, stream/frame coordinates, frame digests, runtime thread and parent-thread relations, role/nickname/depth hints, malformed frames, and truncation state.
- Continue writing existing OpenKit worker events, final status, final assistant message, workspace change manifests, and Git snapshots.
- `packages/worker-shim/README.md`: document the new files, limits, failure behavior, and restricted-data boundary.

### NanoCore Runtime Collection And Evidence

- `apps/nanocore/src/runtime/worker-governance-backend.ts`: collect the raw stream manifest, every listed synthetic stream, and native origin index alongside existing transcript files; preserve exact digests in bundle rows and expose only aggregate counts through RuntimeEvidence.
- `apps/nanocore/src/runtime/worker-transcript.ts`: keep canonical item/artifact import outer-turn-owned and delegate provenance validation to one focused runtime provenance importer rather than mixing native parsing into item promotion.
- Add one cohesive runtime provenance importer/normalizer under `apps/nanocore/src/runtime/` for frame verification, cycle detection, opaque ref minting, product-safe index generation, completeness classification, and deterministic restart behavior.
- `apps/nanocore/src/evidence-bundles.ts`: use the automatic recorder only, add the recognized runtime provenance evidence ref kinds needed by import/export quarantine, and do not use or restore the manual creation helper removed by the sibling plan.
- `apps/nanocore/src/runtime/runtime-evidence.ts`: add the missing transcript-collection producer with stable package-scoped idempotency and product-safe summaries without changing RuntimeEvidence schema or conflating it with the existing materialization and teardown producers.
- Workspace storage helpers and export/import: store restricted files under `evidence/backend/<rawBundleId>/`, store normalized indexes under `evidence/bundles/<indexBundleId>/`, project the restricted runtime provenance bundle with empty raw refs through ordinary reads, retain the product-safe normalized bundle, rewrite an omitted raw bundle as an expired source-digest index with empty raw refs, reject unknown imported required features, and omit raw files and locators from ordinary export without changing other automatic bundle projections.
- Worker checkpoint and turn executor tests: fail provenance-required turns on missing, tampered, truncated, or unsupported capture while preserving quarantined evidence for review.

### Worker Inference Identity And Prompt Cache

- `apps/nanocore/src/app.ts`: add internal `POST /api/worker-inference/v1/chat/completions` and `POST /api/worker-inference/v1/responses` routes that preserve OpenAI-compatible bodies, SSE streaming, cancellation, cache retention, and supported compression semantics while reusing the current provider dispatcher.
- Reuse `WorkerControlGateway` authentication and lease binding to resolve the active AEP package; do not add a second worker identity database.
- Add the smallest focused worker inference context helper needed to separate trusted outer lineage from adapter-provided runtime hints; avoid a new middleware framework.
- `apps/nanocore/src/runtime/worker-control-gateway.ts` and backend relay configuration: expose token-only read-only authentication that derives package lineage server-side, revalidates the durable lease binding, hydrates the durable redacted AEP after restart, and ensures sandbox-supplied credentials or authority metadata cannot bypass it.
- AEP/backend materialization and egress policy: create one per-package OpenShell provider placeholder carrying the short-lived worker token, generate a Codex custom provider that targets the internal worker-inference base URL, allow only the exact host, binary, method, and paths, withhold direct provider credentials, and deny direct provider API egress whenever complete worker-inference attribution is required.
- `packages/openshell-schema-snapshot` and OpenShell policy rendering: align the supported policy subset with repository-pinned 0.0.80 REST path rules and fail backend capability reporting on an incompatible installed version.
- `apps/nanocore/src/llm/prompt-cache-key.ts`: keep generic public precedence unchanged, add a worker-specific derivation path, hash runtime cache lineage with provider/account/model/workspace/runtime family, and use a request-scoped fallback when runtime cache lineage is absent.
- Provider dispatch and relay tests: strip runtime-native hint fields before upstream dispatch and ensure upstream only receives the derived prompt-cache key.
- Record product-safe degraded-cache diagnostics when a request-scoped fallback is necessary.

### Capability Ledger, Protocol, API, And Storage

- `packages/protocol/src/models/capability.ts`, generated JSON Schema, and conformance tests: add nullable optional `packageSnapshotId`, `runtimeOriginRef`, and `runtimeCacheLineageRef` fields and prohibit raw runtime/cache material.
- `packages/app-api-schemas/src/capability-usage.ts` and tests: project all three new fields through existing read-only capability usage responses.
- `apps/nanocore/src/capability/usage-ledger.ts`: accept, validate, persist, list, export, import, and idempotently replay the AEP snapshot id plus both refs, and support turn-end reconciliation of package-scoped inference calls while keeping UsageRecord unchanged.
- `apps/nanocore/src/storage/schema/capability-usage-ledger.ts` and `apps/nanocore/src/storage/migrate.ts`: add the three nullable columns through the current clean one-way internal migration posture.
- Workspace export/import and recovery: remint product-safe runtime refs when package or workspace identity changes while preserving their equality classes, rewrite existing outer workspace/thread/turn lineage according to current import rules, validate ref-to-bundle consistency, and reject unsupported authority-bearing features without a legacy reader.
- `apps/nanocore/src/openapi.ts` and `apps/nanocore/openapi/app-api.openapi.json`: regenerate the existing capability usage schema; no new public sub-agent endpoint is added.
- `packages/core-client`, `mcp`, and Web mocks/tests: accept and preserve optional product-safe refs through existing read-only projections without adding management commands or a new UI.

### Documentation And Acceptance Assets

- Update `apps/nanocore/README.md`, `packages/worker-protocol/README.md`, `packages/worker-shim/README.md`, `packages/config-schema/README.md`, and other affected local file maps after implementation.
- Update the active specs linked above from `Partial` or `Not Started` to their real implementation alignment only after all contracts and tests match.
- Add deterministic primary-exec plus per-thread rollout fixtures and a skip-aware real Codex story that cannot consume subscription quota during default verification.

## Execution Plan

### Phase 1: Trusted Worker Inference Relay Foundation

- Add failing `@openkit/openshell-schema-snapshot`, `@openkit/config-schema`, and NanoCore relay-contract tests proving the per-package placeholder, exact OpenShell REST rules, Codex custom provider projection, token-only package authentication, provider/model binding, runtime-hint preservation, direct-provider denial, streaming, cancellation, and supported compression behavior.
- Align the worker image, generated schema evidence, relay fixtures, and generated Codex custom-provider configuration on Codex 0.144.1.
- Prove against repository-pinned OpenShell 0.0.80 that an explicit REST policy plus per-package provider placeholder can inject the AEP-bound token, preserve runtime hints, SSE, cancellation, and supported compression, configure root and child inference consistently, and block direct provider credentials and egress; if it cannot, fail closed with trusted worker inference and the required feature disabled.
- Implement token-only package and lease authentication, the two thin internal worker-inference routes, exact OpenShell policy rendering, direct-provider credential and egress removal for relay-required packages, abort propagation, supported compression handling, authority-field stripping, and reuse of the existing provider dispatcher and capability ledger.
- Keep `worker.runtime-provenance.v1`, runtime-origin fields, runtime-cache fields, provenance capture, and provenance evidence disabled in this phase.
- Review the vertical slice for a second provider stack, a second identity store, broad egress, leaked credentials, pass-through abstractions, and behavior drift on the public Gateway.

Exit criteria: one relay-required governed root or child Codex call can reach the existing NanoCore dispatcher only through the authenticated package-and-lease-bound route, direct provider access is blocked for that package, the pinned executable relay probe passes, and no provenance completeness claim or product correlation field is enabled.

### Phase 2: Provenance Protocol And AEP Contracts

- Add failing `@openkit/worker-protocol` tests for valid stream manifests, root/child frames across separate streams, malformed frames, truncation, byte ranges, digests, and required features; keep missing-stream, graph-closure, and parent-cycle semantics in the NanoCore importer that owns cross-file verification.
- Add failing `@openkit/config-schema` tests for provenance paths, byte and stream-count limits, adapter capability negotiation, and the dependency on the already-proven trusted inference relay capability.
- Implement only the worker protocol, AEP schema, generated type, and resolver projection additions required to make those tests pass; keep the required feature disabled until capture and import are complete.

Exit criteria: worker and AEP contracts express the accepted capture design, `WorkerLineageSchema`, EvidenceBundle, RuntimeEvidence, UsageRecord, and AuditEvent remain unchanged, and the focused protocol/config tests, typecheck, lint, and build pass.

### Phase 3: Streamed Codex Provenance Adapter

- Add failing worker-shim tests with chunked primary exec JSONL plus separate root and child rollout fixtures whose frame boundaries cross process chunks.
- Cover exact byte preservation, synthetic stream naming, manifest completeness, offsets, digests, reachable root/child/parent mapping, unrelated rollout exclusion, missing or unstable children, global unattributed events, malformed lines, byte/stream limits, process failure, and bounded stderr.
- Refactor the Codex process runner to stream primary stdout with backpressure, discover reachable native threads, copy stable child rollouts incrementally, and write the stream manifest and native origin index.
- Keep the existing final assistant message and workspace Git publication behavior passing.
- Review the completed slice for duplicate buffers, generic adapter abstractions, unbounded strings, leaked native ids, and unnecessary pass-through helpers.

Exit criteria: production Codex execution no longer buffers complete stdout, root-only capture cannot claim complete provenance, deterministic multi-stream fixtures generate a verifiable closed runtime forest, and worker-shim focused/full tests pass.

### Phase 4: NanoCore Provenance Import And Evidence

- Add failing NanoCore tests for manifest collection, exact cross-stream frame verification, adapter index fields that disagree with pinned raw frames, outer lineage mismatch, unlisted or missing streams, missing reachable children, unstable children, digest mismatch, range overlap, missing frames, cycles, truncation, unsupported required features, deterministic normalization, and restart replay.
- Add failing evidence tests proving one automatic restricted-raw bundle, one automatic product-safe turn-evidence index bundle, and one new transcript-collection RuntimeEvidence record are produced, no manual creation path is used, ordinary reads return empty raw refs for the restricted runtime provenance bundle without changing other automatic bundle projections, and raw files and locators are excluded from normal reads and default exports.
- Implement collection and one focused importer/normalizer, then wire it into the existing turn-end transcript path.
- Make automatic EvidenceBundle and RuntimeEvidence writes idempotent with exact-content equality checks so a restart cannot silently ignore divergent replay under a stable id.
- Preserve canonical outer item and artifact import and prove child runtime messages are not flattened.
- Add retention, local-capture quarantine, workspace export, and recovery coverage proving the normalized bundle remains resolvable after raw expiry, an omitted raw bundle exports as an expired source-digest index without changing EvidenceBundle or RuntimeEvidence shape, and interrupted-worker recovery explicitly re-verifies retained provenance instead of relying on a boot-wide scanner.
- Treat unsupported local capture as quarantined restricted evidence that fails a required turn, but reject a portable import with unknown required features through the existing schema-evolution boundary instead of importing it as quarantine.
- Review the slice for duplicated evidence ownership, new product entities, raw-id leakage, and unnecessary storage tables.

Exit criteria: an interleaved runtime forest is reconstructable from retained evidence, canonical product history remains outer-turn-owned, invalid provenance is quarantined or fails required turns, and existing evidence simplification invariants still pass.

### Phase 5: Runtime Origin And Cache Lineage Correlation

- Extend the Phase 1 relay tests with runtime-hint cases proving NanoCore consumes allowlisted origin and cache hints, rejects any authority override, strips native hints before provider dispatch, and preserves the already-proven spoof, lease, provider/model, transport, credential, egress, and root/child guarantees.
- Add failing cache tests for stable same-lineage keys, distinct sibling keys, explicitly declared inherited lineage, parentage without inheritance remaining isolated, provider/account/model/workspace isolation, request-scoped fallback, no outer-thread fallback, and raw-key leak prevention.
- Add failing `@openkit/protocol`, `@openkit/app-api-schemas`, ledger, migration, export, and import tests for `packageSnapshotId`, `runtimeOriginRef`, `runtimeCacheLineageRef`, unique per-call request ids, raw-id leak rejection, and turn-end rejection of missing or unmatched provisional origin refs.
- Extend the trusted worker-inference context from Phase 1 to derive worker prompt-cache keys, write the AEP snapshot and two product-safe capability refs, and reconcile package-scoped calls against the final normalized origin index.
- Strip runtime-native hint fields before upstream dispatch while preserving the authority stripping and shared dispatcher behavior already proved by the relay foundation.
- Review the slice for duplicate provider routing, parallel usage ledgers, public route drift, cache identity conflation, and unnecessary middleware.

Exit criteria: worker calls are durably attributed from trusted AEP lineage, runtime origins and cache lineages are distinguishable, sibling cache behavior matches the accepted contract, and public Gateway behavior remains unchanged.

### Phase 6: Cross-Surface Conformance And Closeout

- Regenerate protocol and OpenAPI artifacts and update Core Client, MCP, Web mocks, package READMEs, spec implementation values, and file maps that consume changed shapes.
- Add one NanoCore black-box fixture covering a primary exec stream, parent plus two child rollout streams, three worker LLM calls, distinct sibling cache lineages, one explicitly inherited cache lineage, turn-end origin reconciliation, blocked direct provider bypass, both automatic evidence bundles, empty restricted-provenance raw refs on ordinary reads, capability usage, audit linkage, and one canonical outer result.
- Add the skip-aware real Codex story behind the repository's existing real-provider quota gates.
- Run focused package verification, NanoCore full verification, repository checks, smoke tests, deterministic stories, and the quota-gated real Codex verification required for final acceptance.
- Review the final diff for compatibility readers, restored manual evidence creation, `WorkspaceSyncEvidenceBundle`, root-only provenance claims, raw-id leakage, full-stdout or full-rollout buffers, duplicate origin/cache fields on UsageRecord or AuditEvent, new product child entities, and unrelated changes.
- Update this change record with implementation commits, meaningful phase checkpoints, deviations, final verification evidence, and remaining follow-ups.

Exit criteria: all acceptance criteria in the owning spec pass, related active specs describe current implementation accurately, and this record can move from `planned` through implementation to `verified` without a duplicate PR summary.

## Verification Plan

- `CI=true pnpm --filter @openkit/openshell-schema-snapshot test`
- `CI=true pnpm --filter @openkit/openshell-schema-snapshot typecheck`
- `CI=true pnpm --filter @openkit/openshell-schema-snapshot lint`
- `CI=true pnpm --filter @openkit/openshell-schema-snapshot build`
- `CI=true pnpm --filter @openkit/codex-app-server-schema test`
- `CI=true pnpm --filter @openkit/codex-app-server-schema lint`
- `CI=true pnpm --filter @openkit/worker-protocol test`
- `CI=true pnpm --filter @openkit/worker-protocol typecheck`
- `CI=true pnpm --filter @openkit/worker-protocol lint`
- `CI=true pnpm --filter @openkit/worker-protocol build`
- `CI=true pnpm --filter @openkit/config-schema test`
- `CI=true pnpm --filter @openkit/config-schema typecheck`
- `CI=true pnpm --filter @openkit/config-schema lint`
- `CI=true pnpm --filter @openkit/config-schema build`
- `CI=true pnpm --filter @openkit/protocol test`
- `CI=true pnpm --filter @openkit/protocol typecheck`
- `CI=true pnpm --filter @openkit/protocol lint`
- `CI=true pnpm --filter @openkit/protocol generate:schema`
- `CI=true pnpm --filter @openkit/app-api-schemas test`
- `CI=true pnpm --filter @openkit/app-api-schemas typecheck`
- `CI=true pnpm --filter @openkit/app-api-schemas lint`
- `CI=true pnpm --filter @openkit/worker-shim test`
- `CI=true pnpm --filter @openkit/worker-shim typecheck`
- `CI=true pnpm --filter @openkit/worker-shim lint`
- `CI=true pnpm --filter @openkit/worker-shim build`
- `CI=true pnpm --filter @openkit/nanocore test`
- `CI=true pnpm --filter @openkit/nanocore typecheck`
- `CI=true pnpm --filter @openkit/nanocore lint`
- `CI=true pnpm --filter @openkit/nanocore build`
- `CI=true pnpm --filter @openkit/nanocore run openapi:check`
- `CI=true pnpm --filter @openkit/core-client test`
- `CI=true pnpm --filter @openkit/core-client typecheck`
- `CI=true pnpm --filter @openkit/mcp test`
- `CI=true pnpm --filter @openkit/mcp typecheck`
- `scripts/docker/build-image.sh worker-codex`
- `scripts/docker/smoke-image.sh worker-codex`
- `CI=true pnpm run format:check`
- `CI=true pnpm run check:repo`
- `CI=true pnpm --filter @openkit/nanocore run test:e2e:smoke`
- `CI=true pnpm -w test:stories`
- `CI=true pnpm -w verify:release`
- `git diff --check`

Real Codex verification remains skip-aware in default CI and requires the explicit provider-quota, target NanoCore, disposable repository, and evidence-directory gates used by `pnpm -w test:stories:real-task-mode`. The quota-authorized A1 gate has completed; default CI continues to skip it and cannot claim or replace that proof.

## Commit And Handoff Plan

- Keep package changes linear and reviewable: openshell-schema-snapshot, config-schema relay projection, Codex schema/image alignment, NanoCore relay foundation, worker-protocol, config-schema provenance projection, worker-shim, NanoCore provenance import, protocol, app-api-schemas, NanoCore correlation storage, then clients/channels/generated docs.
- Begin each behavioral slice with a failing test commit such as `test(worker-protocol): add runtime provenance contracts`, `test(worker-shim): cover Codex sub-agent provenance`, or `test(nanocore): cover trusted worker inference identity`.
- Follow each test commit with the smallest implementation commit using `feat` or `fix`, then add a separate `refactor` commit only when the post-TDD quality review finds a concrete simplification.
- Do not combine the evidence-surface deletion work with this implementation. If both plans touch an evidence importer or generated contract, preserve the deletion plan's smaller public surface and keep runtime provenance as an automatic producer.
- Update this same record at phase completion, material scope change, blocker, implementation closeout, and final verification; do not create a duplicate change record.

## Risks And Mitigations

- Risk: The pinned Codex event fixtures do not match the CLI version in the worker image. Mitigation: bind adapter capability to a tested Codex version/schema digest, preserve raw bytes, and fail required-feature negotiation on unsupported drift.
- Risk: Streaming capture changes process supervision or final message behavior. Mitigation: characterize exit, signal, stderr, final assistant output, and workspace Git publication before refactoring and keep regression tests around all of them.
- Risk: Raw runtime evidence leaks sensitive content. Mitigation: use bounded restricted storage, no ordinary raw-content route, default export exclusion, redaction at the normalized boundary, and canary leak tests.
- Risk: Runtime-native hints are spoofed within an authenticated worker. Mitigation: they remain evidence/performance hints only, are verified against retained provenance, and never influence authority, provider, model, policy, vault, or budget decisions.
- Risk: Dedicated worker-inference routes duplicate the public Gateway. Mitigation: keep route handlers thin and call the same dispatcher, policy, usage, error, and provider services with a stronger trusted context.
- Risk: The runtime bypasses the authenticated OpenKit route, producing apparently complete Gateway attribution while direct provider calls are missing. Mitigation: require root-and-child custom provider configuration, withhold direct credentials, deny direct provider egress, and fail capability negotiation when coverage cannot be proved.
- Risk: A live inference origin hint does not exist in the final runtime forest. Mitigation: treat live refs as provisional, reconcile all package-scoped calls at turn end, preserve the failed call for audit, and refuse complete provenance instead of assigning the call to the root.
- Risk: Cache changes reduce hit rate. Mitigation: preserve explicit runtime cache lineage, measure cached-token effectiveness, support intentional shared lineage, and use request-scoped fallback only when the runtime supplies no stable lineage.
- Risk: Capability call schema changes spread runtime concepts into unrelated records. Mitigation: add only the missing authenticated AEP snapshot lineage plus two optional product-safe refs to the smallest causal record and rely on existing `capabilityCallId` links from usage and audit.
- Risk: Evidence simplification and provenance work conflict. Mitigation: keep plans separate, use automatic EvidenceBundle recording only, leave EvidenceBundle and RuntimeEvidence shapes unchanged, and retain regression coverage for removed manual and synchronization-specific surfaces.

## Checkpoints

- 2026-07-13: Phases 1-5 completed the deterministic trusted-relay, bounded Codex 0.144.1 capture, provenance import and quarantine, automatic evidence, product-safe CapabilityCall correlation, cache-lineage routing, workspace portability, and strict AEP and lease authority contract without changing outer worker lineage or creating runtime-child Core entities.
- 2026-07-15: Phase 6 completed deterministic and cross-surface conformance, exact worker-image and process-policy alignment, and stock OpenShell `0.0.80` disposable-Cell transport, materialization, result collection, failure recovery, and whole-Cell recycle on A1 without a fork, patch, sidecar, or parallel workflow engine.
- 2026-07-16: The quota-authorized real Task acceptance ran against production source HEAD `891eb7e` with stock OpenShell CLI and Gateway `0.0.80`, Codex `0.144.1`, and the A1-built `openkit/worker-codex:dev` image. It completed four streams, one root plus two children, three runtime origins, 18/18 reconciled Gateway calls with 16 successes and two attributed cancellations, three cache lineages, positive cache-read telemetry totaling 152,320 cached-input tokens, one canonical outer assistant result, one teardown, `turn-completed` lease release with zero capacity in use, review rejection, an unchanged clean repository, owner-only `0600` evidence, no remaining sandbox, and an idempotently recycled ready empty Cell.
- 2026-07-16: After the production proof, commits `69b1a0d`, `e2ca3dd`, and `f791df8` changed only test support and documentation. They reused existing Goal-runner process and evidence helpers, narrowed L6 to the five provenance-owned integration oracles, fixed review cleanup error preservation, and removed more than 1,200 lines from the Task runner and its tests; the shortened runner did not rerun or replace the proof at `891eb7e`.

## Current Status

- The design is accepted in `docs/specs/20260711-worker_runtime_subagent_provenance.md`.
- Related active specs describe the deterministic implementation and real Codex executable acceptance as complete. Production capability declaration follows exact platform CLI validation, while each use and launch still fail closed on the required Gateway version, Providers v2 state, and package constraints.
- Phase 1 deterministic relay behavior is complete: exact-version and schema alignment, exact relay-only policy, package-scoped provider materialization, token rotation and revocation, direct credential and egress suppression, worker-shim isolation, live lease authentication, the two internal routes, bounded decoding, compression, cancellation, Codex continuity, runtime hints, and terminal capability recording are implemented. Resource deletion is not part of lifecycle success; the whole disposable Cell is recycled.
- Phase 2 and Phase 3 contracts and capture are complete but opt-in: required packages declare bounded provenance outputs behind the trusted relay, and the worker shim streams the primary process while retaining only the stable reachable rollout forest. Ordinary packages remain unchanged.
- Phase 4 import, verification, normalization, evidence production, quarantine, portability, restricted-raw expiry, restart replay, recovery re-verification, and canonical outer-turn gating are complete.
- Phase 5 CapabilityCall correlation, cache derivation, turn-end reconciliation, and workspace import reminting are complete across protocol, storage, App API, OpenAPI, Core Client, and MCP.
- Phase 6 deterministic conformance, active-spec projection, worker-image packaging, exact process-policy alignment, the skip-aware acceptance asset, and the quota-authorized real Codex 0.144.1 root-plus-two-child Task acceptance are complete on stock OpenShell `0.0.80`.
- The public LLM Gateway intentionally retains caller-supplied `metadata.openkit` as best-effort public attribution; the separate internal worker path authenticates AEP and lease identity and is the only trusted worker attribution path.
- Worker prompt-cache routing now has a distinct trusted runtime lineage contract: explicit native lineage produces a stable provider/account/model/workspace/runtime-family hash, while absent lineage produces a request-scoped key and null `runtimeCacheLineageRef`. CapabilityCall owns the package snapshot and both product-safe refs; UsageRecord and AuditEvent do not duplicate them.
- Ordinary EvidenceBundle reads hide restricted runtime provenance raw refs without changing other automatic bundle projections. Default workspace export retains only the expired raw source-digest row and product-safe normalized index, and import deterministically remints outer lineage, product-safe runtime refs, CapabilityCall correlations, and linked ids while recomputing the normalized digest.
- Current OpenShell backend materialization creates the package-scoped transient generic provider inside one disposable Cell, installs the package token placeholder, removes host credentials and extra direct-provider egress for trusted inference packages, and fails closed unless both stock components are exactly `0.0.80`. The production factory wires trusted inference and runtime provenance declarations, the A1 Task acceptance proves the complete real path, and cleanup succeeds only through whole-Cell recycle.

## Final Implementation Summary

The implementation preserves a bounded Codex runtime forest as restricted evidence, promotes only product-safe origin indexes and correlation refs, keeps runtime children out of canonical Core entities, authenticates worker inference through the AEP package and live lease, isolates worker cache routing from outer OpenKit lineage, reconciles package-scoped worker-inference calls at turn end, and retains portable evidence through workspace export/import without copying raw runtime files. Protocol, App API, OpenAPI, Core Client, MCP, NanoCore storage, worker shim, stock OpenShell policy, the Codex worker image, deterministic conformance, remote Cell lifecycle, and the real A1 Task acceptance are aligned. The result uses no OpenShell fork or patch and adds no parallel workflow or settlement engine.

## Final Verification Evidence

- The opt-in `node tests/story-runner/task-mode-real-worker-runner.mjs` acceptance targeted the A1-connected NanoCore and wrote only its result JSON and redaction notes under `evidence-5`; both files were owned by `ubuntu` with mode `0600`.
- Production source HEAD `891eb7e` ran with unmodified OpenShell CLI and Gateway `0.0.80`, Codex `0.144.1`, and the A1-built `openkit/worker-codex:dev` image. No external dependency was forked or patched.
- The real result was `status: ok`: four streams; one root plus two children; three origins; 18/18 reconciled Gateway calls with 16 succeeded and two attributed cancellations; three cache lineages; positive cache-read telemetry totaling 152,320 cached-input tokens; and one canonical outer assistant result.
- Terminal evidence showed one teardown, lease release reason `turn-completed`, zero scheduler capacity in use, a rejected workspace review, and an unchanged clean repository HEAD. Stock OpenShell reported no remaining sandbox, and the same-owner idempotent recycle passed readiness plus two empty checks separated by 10 seconds.
- Post-proof runner tests pass 16/16 for Task and 20/20 for Goal after the deletion pass. Commits `69b1a0d`, `e2ca3dd`, and `f791df8` changed only test support and documentation after the production proof and did not rerun it.
- Final deterministic L6 passes 65 Node story tests, all five MCP stories, and the Web story; `CI=true pnpm run check:repo`, `CI=true pnpm run format:check`, and `git diff --check` pass on the closeout tree.
- Final `CI=true pnpm -w verify:release` passes repository checks, lint, typecheck, unit tests, coverage, and builds for the full workspace. NanoCore E2E passes 17 files and 21 tests with one file and one test skipped by design, and the NanoCore and Web built-artifact smoke tests pass.
