# Worker Runtime Sub-Agent Provenance And Gateway Identity

Type: change-plan
Status: in-progress

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

Real Codex verification remains skip-aware in default CI and requires the explicit provider-quota, target NanoCore, disposable repository, and evidence-directory gates used by `pnpm -w test:stories:real-task-mode`. It is required before this record can become `verified` or production capabilities can be enabled.

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

- 2026-07-13: Evidence Surface Simplification closed at commit `442b443`, leaving automatic NanoCore evidence production and read-only consumer access as the verified boundary this plan must preserve. Phase 1 began with a clean worktree and a feasibility audit of pinned Codex multi-stream capture, OpenShell `inference.local` relay identity, root-and-child routing, direct-provider egress denial, and restricted evidence projection before any feature contract is declared implemented.
- 2026-07-13: The feasibility audit rejected stock OpenShell `inference.local` for complete attribution because the route is gateway-global and strips the per-AEP identity and native headers this contract requires. The accepted landing path is now a per-package OpenShell credential placeholder plus an exact REST policy into OpenKit's internal worker-inference routes, with fail-closed rollout and no sidecar fallback if the direct binding cannot pass. The audit also found version drift between the Codex 0.130.0 worker image and 0.144.1 schema snapshot, no current transcript-collection RuntimeEvidence producer, restricted raw-ref leakage through ordinary bundle reads and default exports, non-strict evidence replay idempotency, and under-specified normalized-index import reminting; the execution plan now makes each a testable owner-specific requirement.
- 2026-07-13: The Phase 1 foundation pinned the worker image to Codex 0.144.1 and validated it against the vendored schema, required exact OpenShell `0.0.80` before capability claim, snapshotted exact REST rules plus the generic-provider placeholder surface, validated relay-required AEP shape, preserved immutable provider/model selection, and projected relay-required AEPs to the NanoCore worker-inference base URL with placeholder credential visibility, exact Codex POST rules, and no direct sandbox network, credential, provider-backed MCP, vault, or provider attachments. The backend per-package provider lifecycle, token-only WorkerControlGateway binding and restart hydration, internal worker-inference routes and transport, worker-shim token isolation, and executable OpenShell probe remained pending at that checkpoint; no provenance completeness capability or product correlation field was enabled.
- 2026-07-13: The per-package relay provider lifecycle and worker token isolation landed through `848d68e`, `1af05dd`, and `f2e98ad`. Relay-required materialization created one deterministic transient generic provider with the short-lived worker token, rendered only the two exact Codex POST paths for the two pinned Codex binaries, suppressed host Codex auth/config uploads and extra direct egress, rejected backend-private credential injection, validated the connected Gateway version, prevented concurrent duplicate materialization, and revoked rotated and torn-down WorkerControl sessions. The then-current resource-level cleanup path was later replaced by whole-Cell recycle and is not current success evidence. Canonical AEP validation permits exactly the control-local, capability-local, and worker-inference rules, while NanoCore revalidates the package at the backend boundary.
- 2026-07-13: Token-only inference identity and restart hydration landed through `90b55e7`; the internal AEP-bound Chat Completions and Responses routes landed through `7cdc6b1`. Every accepted request now requires a live lease-bound hydrated relay package plus durable Core storage, starts a fresh package-attributed capability call before provider resolution, dispatches only the AEP provider/model through the shared Gateway stack, strips or rejects caller lineage, cache, credential, policy, budget, provider-state, and privileged tool authority, preserves ordinary JSON/SSE behavior, accounts for provider drift and terminal failures, and keeps the public `/v1` Gateway unchanged. Relay-required Codex launch also disables default provider-side web search through `628f22d`. Transport bounding, supported compression, abort propagation, runtime/response header handling, and the same-target executable probe remain pending, so production capability reporting stays off.
- 2026-07-13: Bounded identity and native Zstd decoding landed through `93b1afb` and `4eef50e`. Gateway transport continuity landed through `43d5932`, `796ab34`, `ae6fd22`, `674168d`, and `bc4902d`: request cancellation now reaches Codex, pi-ai, internal agents, public routes, stream converters, and usage observers; downstream cancellation reaches the provider once; capability calls terminate once as succeeded, failed, or cancelled; late usage and finalization failures cannot use a closed database or leak private persistence details; 401 retries release the rejected body and stop after cancellation; and final `x-codex-turn-state` survives only the Codex OAuth and worker response boundary. Ordinary pi-ai providers do not receive Codex-private continuity state. Adapter-native runtime-hint consumption and the same-target OpenShell executable probe remain pending, so production capability reporting stays off.
- 2026-07-13: Pinned Codex runtime-hint conformance landed through `d543918` and `e507510`. The worker boundary now treats `client_metadata["x-codex-turn-metadata"]` as canonical, cross-checks the Codex 0.144.1 session, thread, request, parent, and sub-agent compatibility projections, normalizes custom sub-agent labels to `other`, validates `prompt_cache_key` as transient adapter input, and removes all raw hint material before shared provider dispatch, durable records, and responses. Follow-up review in `c820a99` and `4431a95` closed malformed-canonical fail-open behavior, pinned request-kind drift, internal memory-consolidation projection, and broader raw-value canaries. The same-target OpenShell 0.0.80 executable probe remains pending, so production capability reporting stays off and no provenance or product correlation field is enabled.
- 2026-07-13: Phase 2 contract preparation landed package-by-package through `4929ef3`, `d9e7868`, `0bfbe6a`, `0958f38`, `39f1760`, `1d5ac5b`, and `be1bf0b`. `@openkit/worker-protocol` now owns the strict restricted raw-stream manifest, safe synthetic stream refs, capture and parse states, exact frame coordinates and SHA-256 digests, and native-origin index entries while leaving `WorkerLineageSchema` unchanged. `@openkit/config-schema` and NanoCore AEP resolution now require fixed provenance paths, positive 256 MiB and 64-stream limits, the existing trusted relay dependency, and explicit required-feature negotiation. Review follow-ups in `f46d713`, `218a68e`, `218a8fb`, and `8d838c1` fixed the primary stream to `stream-0000.jsonl`, made declaration and feature requirements bidirectional, tied the declared paths to the canonical transcript root, and moved the feature wire id to the worker protocol owner. Ordinary AEPs remain unchanged, the production backend does not advertise `worker.runtime-provenance.v1`, and no capture, importer, evidence, or correlation behavior is enabled.
- 2026-07-13: Phase 3 streamed Codex provenance capture landed through `093ff72`, `18d93b8`, `bfd0bc7`, `7a9996e`, `bc7eaa2`, `bed2ccd`, `0d61704`, `4a896d9`, `03cc809`, `86e9421`, `f6471b7`, `69ef3a1`, `4a9f8f0`, `6cd40a5`, `fb75cb5`, and `28183c2`. The worker shim now consumes the opt-in AEP declaration, streams exact primary stdout with backpressure instead of retaining the complete process output, bounds stdout and stderr diagnostic prefixes, copies only stable Codex 0.144.1 root and child rollouts reachable through native spawn or parent edges, excludes unrelated rollouts, applies the declared global byte and stream limits plus bounded directory-entry, candidate, frame, and repeated-index-value guards, preserves exact LF frame coordinates and digests, and atomically commits the restricted stream manifest and native-origin index. Completeness review rejects root-only, missing-child, contradictory, partial, changing, identity-drifting, oversized-index, or bounded forests; preserves malformed frames with explicit parse status; invalidates stale manifest commit markers before capture; suppresses native output from ordinary failure diagnostics; bounds failed child-process termination and drain settling; stops reading rollout files once retention is bounded; and validates stable rollout file identity. Ordinary runs and the existing final assistant, lifecycle transcript, and workspace publication behavior remain covered. The package passes all 59 tests plus typecheck, lint, and build. The same-target OpenShell 0.0.80 executable relay probe and Phase 4 NanoCore importer and evidence work remain pending, so production capability reporting stays off.
- 2026-07-13: Phase 4 NanoCore import is partially implemented. Automatic exact-replay EvidenceBundle and transcript-collection RuntimeEvidence writers, bounded backend-local manifest and stream collection, one focused Codex 0.144.1 importer, exact frame and digest verification, raw/index bundle separation, product-safe opaque normalization, missing-file quarantine, parse-claim and pinned-field cross-checking, native graph closure, actual retained-byte enforcement, and turn-end provenance gating before canonical transcript import landed through `64808fb`, `57abf5b`, `9270e53`, `c4809e4`, `6dd1faf`, `5108125`, `e0b0571`, `f3bd1ea`, `0a1d4a3`, `a5f415f`, `ca80f82`, `e27adc0`, `8d52559`, `16016de`, `cd79183`, `c6f1480`, `9d7625d`, `afc1952`, `fe74d5f`, and `e78f99e`. Required turns now fail closed while retaining quarantine evidence, and child runtime messages cannot enter canonical outer items. Production capability reporting remains off. Phase 4 remains open for the normalized-index workspace export/import and reminting loop, restricted-raw expiry, retained-provenance checkpoint recovery, ref-kind and required-feature import handling, and restart replay timestamp semantics.
- 2026-07-13: Phase 4 completed through `eebd769`, `63b2da7`, `b428e42`, `f749e70`, `fbff40d`, `88e30f7`, `59847b2`, `b83b347`, `fa3f77c`, `c547b5f`, `39d535d`, `e546d20`, `effb9ca`, and `d868027`. NanoCore now accepts exact restart replay with a later observation time, recognizes the complete evidence ref and required-feature set, expires restricted raw provenance by deleting only `evidence/backend/<rawBundleId>/`, re-verifies retained required evidence before explicit terminal checkpoint clearing, supports verified multi-root forests, produces complete product-safe summaries, and redacts replay conflicts. Default workspace export writes only the normalized index, rewrites the omitted raw row to expired with empty refs, and never inventories backend raw files; import rejects incomplete linkage, remints outer lineage plus package, bundle, and RuntimeEvidence ids, recomputes the normalized digest, and stages the index through the existing atomic workspace publication callback. The full NanoCore suite passes 205 test files with 1 skip and 1,745 tests with 7 skips; typecheck, lint, build, and repository checks pass. Phase 5 correlation remains pending and production capability reporting remains disabled.
- 2026-07-13: Phase 5 completed through `722cc9e`, `1d863af`, `1a28fba`, `03f5bd3`, `b02ec98`, `be9a691`, `1485139`, `dfa4d91`, `d5c52df`, `c104e7b`, `bc091a5`, `97ec570`, `3951be4`, `d36511c`, and `0212754`. CapabilityCall now carries the authorizing package snapshot plus product-safe runtime-origin and cache-lineage refs through protocol, App API, SQLite migration, OpenAPI, Core Client, and MCP. The trusted worker route requires canonical hints for provenance-required packages, keeps the public Gateway unchanged, derives cache keys without outer-thread fallback, records request-scoped degradation without storing upstream keys, and preserves unique per-call request ids. Turn-end import reconciles every package-scoped gateway call against the verified normalized origin set without rewriting failures to the root. Workspace import remints package-, origin-, parent-, turn-, and workspace-cache refs consistently, preserves ref equality classes, and rejects unmatched call origins. NanoCore passes 205 test files with 1 skip and 1,758 tests with 7 skips plus typecheck, lint, build, and OpenAPI validation. Production capability reporting remains disabled until Phase 6 executable and cross-surface conformance closeout.
- 2026-07-13: Phase 6 deterministic conformance landed through `ff11d30`, with local guide updates in `1813cc3` and `fe3b3c4`. One in-process cross-surface fixture now runs a four-stream runtime forest, three authenticated worker-inference HTTP calls, three distinct origins, sibling cache isolation, explicit root-to-child cache sharing, an authenticated provider-selection bypass rejection, 3/3 turn-end reconciliation, one raw and one normalized bundle, hidden ordinary raw refs, RuntimeEvidence, capability usage, audit linkage, and one canonical outer assistant result. NanoCore smoke passes 4/4 and deterministic L6 stories pass 36 runner tests, five MCP stories, and one Web story. This is conformance evidence, not the required same-target OpenShell executable proof.
- 2026-07-13: Related implementation projections were aligned in `4c15867`: the owning and dependent specs now distinguish completed deterministic Phase 1-5 behavior and cross-surface conformance from the still-disabled production capability path and missing same-target executable proof.
- 2026-07-13: Worker image build review found and fixed two real packaging defects. `cd11437` and `bca5186` corrected the Codex 0.144.1 binary symlink to `/usr/local/lib/codex/bin/codex`; `c8d07ea`, `76c6251`, `0831142`, `5a469f9`, and `63114fc` then aligned config-schema, AEP generation, exact OpenShell process policy, backend defaults, and regression tests with that packaged path. The rebuilt `openkit/worker-codex:dev` image and its smoke command pass with `codex-cli 0.144.1`.
- 2026-07-13: The skip-aware real Task Mode acceptance asset landed through `1798cbf` and `1adced6`, with guide updates in `405c10d`. It reuses the existing provider-quota gates, requires a completed Task Mode turn, and verifies public OpenShell 0.0.80 RuntimeEvidence, a root plus two children, four retained streams, complete worker-inference reconciliation, package and outer lineage, unique request ids, distinct cache lineages, usage and `capability.finish` audit linkage, the two automatic bundle projections, one canonical outer assistant result, and runtime-native and credential leak canaries. Missing positive cache-read rows are recorded as zero or unreported because the provider does not guarantee cache hits. The default command remains a true skip and does not claim real proof.
- 2026-07-13: The remaining same-target gate was blocked by external prerequisites rather than reported as skipped success. An exact OpenShell `0.0.80` test binary and worker image were available, but the connected local Gateway was `0.0.63`, the configured A1 target tunnel was disconnected, and no authorized real Codex quota run or authoritative pinned multi-agent Responses fixture was available. The required proof still had to run the real Codex root-and-two-child path through the package-scoped provider placeholder and exact process/network policy, preserve transport and cache telemetry, and complete teardown on the same exact-version target.
- 2026-07-13: The external prerequisites became available. A disposable A1 target ran stock OpenShell `0.0.80`, the arm64 `openkit/worker-codex:dev` image was built and smoked on A1 with Node 24.18.0 and Codex 0.144.1, and one quota-authorized real Goal completed through the package-scoped relay with the recorded proof file, usage, capability, audit, evidence, runtime-evidence, workspace review, and unchanged repository HEAD. That run exposed three false identity assumptions in workspace cleanup and recovery: sandbox, agent-session, and package ids had been overloaded as `workerSessionId`. Commits `d53b0e4`, `0b964f2`, `485277e`, `f32c942`, `16b66e0`, `e9df98f`, `ff9824a`, and `ea31f8e` made package lineage mandatory on materializations and backend handles, removed inferred input/materialization records, reminted package lineage on import, correlated terminal, teardown, maintenance, and restart recovery by package, and preserved real sandbox ids only as backend session identity. Its empty resource inventory is historical evidence, not proof of the current whole-Cell cleanup contract, and the exact real root-plus-two-child Task acceptance remains open.
- 2026-07-15: The OpenShell boundary was reset to one disposable Cell built from official unmodified CLI and Gateway `0.0.80`. Product code now uses only the fixed platform CLI path, prepares and recycles the Cell through the fixed helper, and never treats provider or sandbox deletion as teardown proof. Remote placement reaches the Cell's loopback-only Gateway through an operator-managed SSH local-forward exposed as a credential-free loopback HTTP origin; lifecycle control uses a separate fixed SSH command with forwarding disabled. The completed opt-in remote backend E2E proves stock Gateway transport, sandbox materialization, command execution, result download, and whole-Cell recycle on A1. A1 failure injection also proves same-boot Docker loss fails closed, cross-boot same-owner recovery succeeds, and a persisted `fenced` marker makes post-fence root-removal retry independent of the vanished Docker socket. These tests do not run the real Codex root-plus-two-child workload, so full provenance acceptance remains pending.

## Current Status

- The design is accepted in `docs/specs/20260711-worker_runtime_subagent_provenance.md`.
- Related active specs describe the deterministic implementation as complete and keep the full real Codex executable acceptance explicitly pending; production capability declaration is configured support, not proof.
- Phase 1 deterministic relay behavior is complete: exact-version and schema alignment, exact relay-only policy, package-scoped provider materialization, token rotation and revocation, direct credential and egress suppression, worker-shim isolation, live lease authentication, the two internal routes, bounded decoding, compression, cancellation, Codex continuity, runtime hints, and terminal capability recording are implemented. Resource deletion is not part of lifecycle success; the whole disposable Cell is recycled.
- Phase 2 and Phase 3 contracts and capture are complete but opt-in: required packages declare bounded provenance outputs behind the trusted relay, and the worker shim streams the primary process while retaining only the stable reachable rollout forest. Ordinary packages remain unchanged.
- Phase 4 import, verification, normalization, evidence production, quarantine, portability, restricted-raw expiry, restart replay, recovery re-verification, and canonical outer-turn gating are complete.
- Phase 5 CapabilityCall correlation, cache derivation, turn-end reconciliation, and workspace import reminting are complete across protocol, storage, App API, OpenAPI, Core Client, and MCP.
- Phase 6 deterministic conformance, active-spec projection, worker-image packaging, exact process-policy alignment, and the skip-aware real acceptance asset are complete. The current remote Cell E2E proves stock `0.0.80` transport, sandbox execution, result collection, and whole-Cell recycle; the real Codex 0.144.1 root-plus-two-child Task remains pending.
- The public LLM Gateway intentionally retains caller-supplied `metadata.openkit` as best-effort public attribution; the separate internal worker path authenticates AEP and lease identity and is the only trusted worker attribution path.
- Worker prompt-cache routing now has a distinct trusted runtime lineage contract: explicit native lineage produces a stable provider/account/model/workspace/runtime-family hash, while absent lineage produces a request-scoped key and null `runtimeCacheLineageRef`. CapabilityCall owns the package snapshot and both product-safe refs; UsageRecord and AuditEvent do not duplicate them.
- Ordinary EvidenceBundle reads hide restricted runtime provenance raw refs without changing other automatic bundle projections. Default workspace export retains only the expired raw source-digest row and product-safe normalized index, and import deterministically remints outer lineage, product-safe runtime refs, CapabilityCall correlations, and linked ids while recomputing the normalized digest.
- Current OpenShell backend materialization creates the package-scoped transient generic provider inside one disposable Cell, installs the package token placeholder, removes host credentials and extra direct-provider egress for trusted inference packages, and fails closed unless both stock components are exactly `0.0.80`. The production factory wires trusted inference and runtime provenance declarations, but cleanup succeeds only through whole-Cell recycle and full real Codex provenance remains unproved.

## Final Implementation Summary

The deterministic implementation preserves a bounded Codex runtime forest as restricted evidence, promotes only product-safe origin indexes and correlation refs, keeps runtime children out of canonical Core entities, authenticates worker inference through the AEP package and live lease, isolates worker cache routing from outer OpenKit lineage, reconciles package-scoped worker-inference calls at turn end, and retains portable evidence through workspace export/import without copying raw runtime files. Protocol, App API, OpenAPI, Core Client, MCP, NanoCore storage, worker shim, OpenShell policy, the Codex worker image, and deterministic conformance are aligned. The stock remote Cell transport, execution, result collection, failure recovery, and whole-runtime cleanup path is implemented, but this record remains in progress because the full real Codex root-plus-two-child provenance acceptance has not run on that path.

## Final Verification Evidence

- `@openkit/config-schema`: 9 test files and 85 tests pass, followed by typecheck, lint, and build.
- NanoCore: 205 test files pass with 1 skipped; 1,758 tests pass with 7 skipped, followed by typecheck, lint, and build.
- Deterministic L6: 38 story-runner tests, five MCP stories, and one Web story pass. The real Task Mode runner's default command exits with an explicit skip before contacting NanoCore.
- Container: `scripts/docker/build-image.sh worker-codex` succeeds, and `scripts/docker/smoke-image.sh worker-codex` reports Node 24.18.0 and `codex-cli 0.144.1`.
- Generated and repository checks: protocol JSON Schema regeneration produces no diff; `CI=true pnpm run check:repo`, `CI=true pnpm run format:check`, and `git diff --check` pass.
- Final HEAD passes `CI=true pnpm -w verify:release`, including L0-L2 package verification and coverage, NanoCore e2e with 16 files and 20 tests passing plus 1 file and 1 test skipped, NanoCore built-artifact smoke, and Web built-artifact smoke.
- Open acceptance: the quota-gated `pnpm -w test:stories:real-task-mode` has not yet executed the real Codex 0.144.1 root-and-two-child workload through the stock OpenShell `0.0.80` disposable A1 Cell. The run must prove transport, cache telemetry, complete provenance reconciliation, package/handle/lease correlation, and successful whole-Cell recycle before this record becomes verified.
