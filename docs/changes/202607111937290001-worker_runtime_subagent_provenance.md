# Worker Runtime Sub-Agent Provenance And Gateway Identity

Type: change-plan
Status: planned

## Intent

Implement the accepted worker-runtime sub-agent provenance contract so one NanoCore-owned worker turn can safely contain many runtime-native parent and child threads without losing raw causal structure, corrupting canonical product history, or collapsing sibling prompt-cache routing.

The same change will close the current worker LLM Gateway identity gap by adding an authenticated AEP-bound worker inference path, product-safe runtime origin and cache correlation on `CapabilityCall`, and worker-specific prompt-cache derivation that never trusts request-body OpenKit metadata as authority.

## Scope

- Add worker protocol records for byte-addressed raw runtime frame provenance and runtime-native origin indexing while keeping `WorkerLineageSchema` unchanged.
- Extend AEP transcript and backend-required-feature projections for `worker.runtime-provenance.v1`, raw runtime stream-set paths, byte and stream-count limits, and trusted worker inference relay support.
- Change the Codex worker shim from whole-process stdout buffering to bounded primary streaming plus reachable child-rollout collection, generate a restricted stream manifest and native origin index, and preserve the final normalized outer assistant result.
- Collect, verify, normalize, quarantine, retain, and summarize runtime provenance in NanoCore.
- Automatically create one restricted-raw provenance EvidenceBundle, one product-safe turn-evidence index bundle, and one existing transcript-collection RuntimeEvidence projection without changing any record shape.
- Add authenticated internal worker-inference routes behind the sandbox-visible `inference.local` endpoint and bind each request to the registered AEP snapshot and active worker lease.
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
- Runtime provenance EvidenceBundle creation is automatic and uses separate existing `restricted-raw` and `turn-evidence` retention classes; RuntimeEvidence uses its existing transcript-collection phase and `evidenceBundleIds` linkage.
- Ordinary EvidenceBundle reads and default exports expose the restricted bundle index with empty raw refs while retaining product-safe lineage, digests, retention, sensitivity, status, and required-feature metadata.
- Worker inference authority comes only from an authenticated active AEP and lease binding.
- Worker `metadata.openkit` and arbitrary headers cannot establish or override workspace, thread, turn, agent-session, package, provider, model, permission, budget, or policy context.
- Each worker inference call gets a unique capability request id even when all calls share one outer AEP request id.
- Every provisional `runtimeOriginRef` on an AEP-bound worker-inference call is reconciled to exactly one origin in the final normalized index before complete attribution is claimed.
- Worker cache derivation never falls back to a shared outer thread, turn, or agent-session scope.
- Raw runtime cache lineage and derived upstream prompt-cache keys are never stored in product records.
- `packageSnapshotId`, `runtimeOriginRef`, and `runtimeCacheLineageRef` live on `CapabilityCall`; linked UsageRecord and AuditEvent rows do not duplicate them.
- The public LLM Gateway routes remain generic, while sandbox-visible `inference.local` maps to authenticated internal worker-inference routes over the same provider dispatcher.
- The selected inference relay proves trusted binding injection plus streaming, cancellation, runtime-hint forwarding, credential stripping, and supported request compression before worker launch.
- A relay-required AEP forces root and child inference through `inference.local`, withholds direct provider credentials, and blocks direct provider API egress; inability to prove that coverage fails capability negotiation.
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
- Discover only the runtime forest reachable from the primary `thread.started` id, snapshot stable child streams under synthetic names, and fail completeness when a referenced child is missing, still running, or still changing.
- Preserve exact primary and child bytes, stream/frame coordinates, frame digests, runtime thread and parent-thread relations, role/nickname/depth hints, malformed frames, and truncation state.
- Continue writing existing OpenKit worker events, final status, final assistant message, workspace change manifests, and Git snapshots.
- `packages/worker-shim/README.md`: document the new files, limits, failure behavior, and restricted-data boundary.

### NanoCore Runtime Collection And Evidence

- `apps/nanocore/src/runtime/worker-governance-backend.ts`: collect the raw stream manifest, every listed synthetic stream, and native origin index alongside existing transcript files and carry collection digests and sizes into transcript evidence.
- `apps/nanocore/src/runtime/worker-transcript.ts`: keep canonical item/artifact import outer-turn-owned and delegate provenance validation to one focused runtime provenance importer rather than mixing native parsing into item promotion.
- Add one cohesive runtime provenance importer/normalizer under `apps/nanocore/src/runtime/` for frame verification, cycle detection, opaque ref minting, product-safe index generation, completeness classification, and deterministic restart behavior.
- `apps/nanocore/src/evidence-bundles.ts`: use the automatic recorder only, add the recognized runtime provenance evidence ref kinds needed by import/export quarantine, and do not use or restore the manual creation helper removed by the sibling plan.
- `apps/nanocore/src/runtime/runtime-evidence.ts`: extend the existing transcript-collection producer behavior and summaries without changing RuntimeEvidence schema.
- Workspace storage helpers and export/import: store restricted files under the workspace evidence boundary, project restricted bundles with empty raw refs through ordinary reads, retain the product-safe normalized bundle, rewrite an omitted raw bundle as an expired digest-only index with empty raw refs, quarantine unknown required features, and omit raw files and locators from ordinary export.
- Worker checkpoint and turn executor tests: fail provenance-required turns on missing, tampered, truncated, or unsupported capture while preserving quarantined evidence for review.

### Worker Inference Identity And Prompt Cache

- `apps/nanocore/src/app.ts`: add internal `POST /api/worker-inference/v1/chat/completions` and `POST /api/worker-inference/v1/responses` routes that preserve OpenAI-compatible bodies, SSE streaming, cancellation, cache retention, and supported compression semantics while reusing the current provider dispatcher.
- Reuse `WorkerControlGateway` authentication and lease binding to resolve the active AEP package; do not add a second worker identity database.
- Add the smallest focused worker inference context helper needed to separate trusted outer lineage from adapter-provided runtime hints; avoid a new middleware framework.
- `apps/nanocore/src/runtime/worker-control-gateway.ts` and backend relay configuration: expose a read-only authenticated package/lease binding suitable for inference routing and ensure sandbox-supplied credentials or authority metadata cannot bypass it.
- AEP/backend materialization and egress policy: configure the root runtime and every internal child to use `inference.local`, withhold direct provider credentials, and deny direct provider API egress whenever complete worker-inference attribution is required.
- `apps/nanocore/src/llm/prompt-cache-key.ts`: keep generic public precedence unchanged, add a worker-specific derivation path, hash runtime cache lineage with provider/account/model/workspace/runtime family, and use a request-scoped fallback when runtime cache lineage is absent.
- Provider dispatch and relay tests: strip runtime-native hint fields before upstream dispatch and ensure upstream only receives the derived prompt-cache key.
- Record product-safe degraded-cache diagnostics when a request-scoped fallback is necessary.

### Capability Ledger, Protocol, API, And Storage

- `packages/protocol/src/models/capability.ts`, generated JSON Schema, and conformance tests: add nullable optional `packageSnapshotId`, `runtimeOriginRef`, and `runtimeCacheLineageRef` fields and prohibit raw runtime/cache material.
- `packages/app-api-schemas/src/capability-usage.ts` and tests: project all three new fields through existing read-only capability usage responses.
- `apps/nanocore/src/capability/usage-ledger.ts`: accept, validate, persist, list, export, import, and idempotently replay the AEP snapshot id plus both refs, and support turn-end reconciliation of package-scoped inference calls while keeping UsageRecord unchanged.
- `apps/nanocore/src/storage/schema/capability-usage-ledger.ts` and `apps/nanocore/src/storage/migrate.ts`: add the three nullable columns through the current clean one-way internal migration posture.
- Workspace export/import and recovery: preserve product-safe runtime refs while rewriting existing outer workspace/thread/turn lineage according to current import rules, validate ref-to-bundle consistency, and reject unsupported authority-bearing features without a legacy reader.
- `apps/nanocore/src/openapi.ts` and `apps/nanocore/openapi/app-api.openapi.json`: regenerate the existing capability usage schema; no new public sub-agent endpoint is added.
- `packages/core-client`, `mcp`, and Web mocks/tests: accept and preserve optional product-safe refs through existing read-only projections without adding management commands or a new UI.

### Documentation And Acceptance Assets

- Update `apps/nanocore/README.md`, `packages/worker-protocol/README.md`, `packages/worker-shim/README.md`, `packages/config-schema/README.md`, and other affected local file maps after implementation.
- Update the active specs linked above from `Partial` or `Not Started` to their real implementation alignment only after all contracts and tests match.
- Add deterministic primary-exec plus per-thread rollout fixtures and a skip-aware real Codex story that cannot consume subscription quota during default verification.

## Execution Plan

### Phase 1: Protocol And Contract Tests First

- Add failing `@openkit/worker-protocol` tests for valid stream manifests, root/child frames across separate streams, malformed frames, truncation, byte ranges, digests, missing streams, parent cycles, and required features.
- Add failing `@openkit/config-schema` tests for provenance paths, byte and stream-count limits, adapter capability negotiation, and trusted inference relay requirements.
- Add failing `@openkit/protocol` and `@openkit/app-api-schemas` tests for nullable product-safe capability refs and raw-id leak rejection.
- Prove against the pinned OpenShell/runtime backend that `inference.local` can inject an AEP-bound session identity, preserve runtime hints, SSE, cancellation, and supported compression without exposing the token, configure root and child inference consistently, and block direct provider credentials and egress; if it cannot, select the existing OpenKit-owned relay path before implementation continues.
- Implement the smallest schema additions, generated schema changes, and AEP resolver projection required to make those tests pass.

Exit criteria: package contracts express the accepted design, `WorkerLineageSchema`, EvidenceBundle, RuntimeEvidence, UsageRecord, and AuditEvent remain unchanged, and protocol/config packages pass focused tests, typecheck, lint, and build.

### Phase 2: Streamed Codex Provenance Adapter

- Add failing worker-shim tests with chunked primary exec JSONL plus separate root and child rollout fixtures whose frame boundaries cross process chunks.
- Cover exact byte preservation, synthetic stream naming, manifest completeness, offsets, digests, reachable root/child/parent mapping, unrelated rollout exclusion, missing or unstable children, global unattributed events, malformed lines, byte/stream limits, process failure, and bounded stderr.
- Refactor the Codex process runner to stream primary stdout with backpressure, discover reachable native threads, copy stable child rollouts incrementally, and write the stream manifest and native origin index.
- Keep the existing final assistant message and workspace Git publication behavior passing.
- Review the completed slice for duplicate buffers, generic adapter abstractions, unbounded strings, leaked native ids, and unnecessary pass-through helpers.

Exit criteria: production Codex execution no longer buffers complete stdout, root-only capture cannot claim complete provenance, deterministic multi-stream fixtures generate a verifiable closed runtime forest, and worker-shim focused/full tests pass.

### Phase 3: NanoCore Provenance Import And Evidence

- Add failing NanoCore tests for manifest collection, exact cross-stream frame verification, adapter index fields that disagree with pinned raw frames, outer lineage mismatch, unlisted or missing streams, missing reachable children, unstable children, digest mismatch, range overlap, missing frames, cycles, truncation, unsupported required features, deterministic normalization, and restart replay.
- Add failing evidence tests proving one automatic restricted-raw bundle, one automatic product-safe turn-evidence index bundle, and one existing transcript-collection RuntimeEvidence record are produced, no manual creation path is used, ordinary reads return empty raw refs for the restricted bundle, and raw files and locators are excluded from normal reads and default exports.
- Implement collection and one focused importer/normalizer, then wire it into the existing turn-end transcript path.
- Preserve canonical outer item and artifact import and prove child runtime messages are not flattened.
- Add retention, import quarantine, workspace export, and recovery coverage proving the normalized bundle remains resolvable after raw expiry and an omitted raw bundle exports as an expired digest-only index without changing EvidenceBundle or RuntimeEvidence shape.
- Review the slice for duplicated evidence ownership, new product entities, raw-id leakage, and unnecessary storage tables.

Exit criteria: an interleaved runtime forest is reconstructable from retained evidence, canonical product history remains outer-turn-owned, invalid provenance is quarantined or fails required turns, and existing evidence simplification invariants still pass.

### Phase 4: Trusted Worker Inference And Cache Lineage

- Add failing NanoCore route tests proving public request metadata cannot establish worker authority and an active AEP/lease-bound token can while preserving SSE streaming, cancellation, cache retention, and supported compression.
- Add failing spoof, expired lease, wrong package, wrong workspace, disallowed provider/model, missing relay capability, direct provider credential, direct provider egress, and root/child relay-bypass tests.
- Add failing cache tests for stable same-lineage keys, distinct sibling keys, explicitly declared inherited lineage, parentage without inheritance remaining isolated, provider/account/model/workspace isolation, request-scoped fallback, no outer-thread fallback, and raw-key leak prevention.
- Add failing ledger/migration/export/import tests for `packageSnapshotId`, `runtimeOriginRef`, `runtimeCacheLineageRef`, unique per-call request ids, and turn-end rejection of missing or unmatched provisional origin refs.
- Implement the two internal worker-inference routes as a thin authenticated context projection over the existing dispatcher, usage recorder, policy checks, and error normalization.
- Reuse the existing worker-control token and lease registry, strip authority metadata and native hints before upstream dispatch, derive worker prompt-cache keys, write the two product-safe capability refs, and reconcile package-scoped calls against the final normalized origin index.
- Review the slice for duplicate provider routing, parallel usage ledgers, public route drift, cache identity conflation, and unnecessary middleware.

Exit criteria: worker calls are durably attributed from trusted AEP lineage, runtime origins and cache lineages are distinguishable, sibling cache behavior matches the accepted contract, and public Gateway behavior remains unchanged.

### Phase 5: Cross-Surface Conformance And Closeout

- Regenerate protocol and OpenAPI artifacts and update Core Client, MCP, Web mocks, package READMEs, spec implementation values, and file maps that consume changed shapes.
- Add one NanoCore black-box fixture covering a primary exec stream, parent plus two child rollout streams, three worker LLM calls, distinct sibling cache lineages, one explicitly inherited cache lineage, turn-end origin reconciliation, blocked direct provider bypass, both automatic evidence bundles, empty raw refs on ordinary reads, capability usage, audit linkage, and one canonical outer result.
- Add the skip-aware real Codex story behind the repository's existing real-provider quota gates.
- Run focused package verification, NanoCore full verification, repository checks, smoke tests, deterministic stories, and optional real Codex verification.
- Review the final diff for compatibility readers, restored manual evidence creation, `WorkspaceSyncEvidenceBundle`, root-only provenance claims, raw-id leakage, full-stdout or full-rollout buffers, duplicate origin/cache fields on UsageRecord or AuditEvent, new product child entities, and unrelated changes.
- Update this change record with implementation commits, meaningful phase checkpoints, deviations, final verification evidence, and remaining follow-ups.

Exit criteria: all acceptance criteria in the owning spec pass, related active specs describe current implementation accurately, and this record can move from `planned` through implementation to `verified` without a duplicate PR summary.

## Verification Plan

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
- `CI=true pnpm run format:check`
- `CI=true pnpm run check:repo`
- `CI=true pnpm --filter @openkit/nanocore run test:e2e:smoke`
- `CI=true pnpm -w test:stories`
- `CI=true pnpm -w verify:release`
- `git diff --check`

Optional real Codex verification remains skip-aware and requires the existing explicit provider-quota and repository-root environment gates used by `pnpm -w test:stories:real-codex`.

## Commit And Handoff Plan

- Keep package changes linear and reviewable: worker-protocol, config-schema, protocol, app-api-schemas, worker-shim, NanoCore, then clients/channels/generated docs.
- Begin each behavioral slice with a failing test commit such as `test(worker-protocol): add runtime provenance contracts`, `test(worker-shim): cover Codex sub-agent provenance`, or `test(nanocore): cover trusted worker inference identity`.
- Follow each test commit with the smallest implementation commit using `feat` or `fix`, then add a separate `refactor` commit only when the post-TDD quality review finds a concrete simplification.
- Do not combine the evidence-surface deletion work with this implementation. If both plans touch an evidence importer or generated contract, preserve the deletion plan's smaller public surface and keep runtime provenance as an automatic producer.
- Update this same record at phase completion, material scope change, blocker, implementation closeout, and final verification; do not create a duplicate change record.

## Risks And Mitigations

- Risk: The pinned Codex event fixtures do not match the CLI version in the worker image. Mitigation: bind adapter capability to a tested Codex version/schema digest, preserve raw bytes, and fail required-feature negotiation on unsupported drift.
- Risk: Streaming capture changes process supervision or final message behavior. Mitigation: characterize exit, signal, stderr, final assistant output, and workspace Git publication before refactoring and keep regression tests around all of them.
- Risk: Raw runtime evidence leaks sensitive content. Mitigation: use bounded restricted storage, no normal read route, default export exclusion, redaction at the normalized boundary, and canary leak tests.
- Risk: Runtime-native hints are spoofed within an authenticated worker. Mitigation: they remain evidence/performance hints only, are verified against retained provenance, and never influence authority, provider, model, policy, vault, or budget decisions.
- Risk: Dedicated worker-inference routes duplicate the public Gateway. Mitigation: keep route handlers thin and call the same dispatcher, policy, usage, error, and provider services with a stronger trusted context.
- Risk: The runtime bypasses `inference.local`, producing apparently complete Gateway attribution while direct provider calls are missing. Mitigation: require root-and-child relay configuration, withhold direct credentials, deny direct provider egress, and fail capability negotiation when coverage cannot be proved.
- Risk: A live inference origin hint does not exist in the final runtime forest. Mitigation: treat live refs as provisional, reconcile all package-scoped calls at turn end, preserve the failed call for audit, and refuse complete provenance instead of assigning the call to the root.
- Risk: Cache changes reduce hit rate. Mitigation: preserve explicit runtime cache lineage, measure cached-token effectiveness, support intentional shared lineage, and use request-scoped fallback only when the runtime supplies no stable lineage.
- Risk: Capability call schema changes spread runtime concepts into unrelated records. Mitigation: add only the missing authenticated AEP snapshot lineage plus two optional product-safe refs to the smallest causal record and rely on existing `capabilityCallId` links from usage and audit.
- Risk: Evidence simplification and provenance work conflict. Mitigation: keep plans separate, use automatic EvidenceBundle recording only, leave EvidenceBundle and RuntimeEvidence shapes unchanged, and retain regression coverage for removed manual and synchronization-specific surfaces.

## Current Status

- The design is accepted in `docs/specs/20260711-worker_runtime_subagent_provenance.md`.
- Related active specs now identify the new ownership boundary and the current AEP/worker capability alignment as partial where appropriate.
- Implementation has not started.
- Current Codex worker execution still buffers and discards successful raw JSON stdout, and current transcript import cannot reconstruct runtime-internal parent-child activity.
- Current public LLM Gateway attribution still depends on caller-supplied `metadata.openkit`, and there is no authenticated AEP-bound worker inference route.
- Current worker prompt-cache behavior has no distinct runtime cache lineage contract, and `CapabilityCall` has no AEP snapshot, runtime-origin, or runtime-cache correlation fields.
- Current EvidenceBundle reads and workspace exports preserve stored raw refs, so the restricted product projection required by this plan is not implemented.

## Final Implementation Summary

Pending.

## Final Verification Evidence

Pending.
