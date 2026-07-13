# App API OpenAPI Projection

Status: Accepted
Implementation: Implemented

## Owns

- The rule that the shared Zod schema packages remain the single contract source for the App API, and that OpenAPI is a generated projection, never a source.
- The projection association between App API routes and shared-package schemas: every public route selects one catalog operation whose documented request, response, and error shapes reference the shared packages, while handler runtime validation remains owned by the handler's shared-schema imports and behavior tests.
- The generated OpenAPI document: generation discipline, versioning, serving route, and drift control.
- The SSE documentation rule: how streaming routes appear in the OpenAPI projection without OpenAPI becoming the streaming contract owner.
- Consumption rules: what the OpenAPI document may and may not be used for, including the one-first-party-SDK rule.
- Route coverage completeness checking.

## Does Not Own

- Schema contents and their package boundaries. `packages/protocol` and `packages/app-api-schemas` own their schemas; `docs/specs/20260628-protocol_contract_consolidation.md` and `docs/specs/20260528-core_client_boundary.md` own the layering.
- The `@openkit/core-client` SDK design and sub-client composition (`docs/specs/20260528-core_client_boundary.md`).
- The Core HTTP/SSE projection under `/api/workspaces`, `/api/turns`, `/api/approvals`, and related Core routes. `@openkit/protocol`, `@openkit/core-client`, `docs/core/protocol.md`, and `docs/core/communication.md` own that transport projection.
- Protocol event envelope, SSE semantics, stream cursors, and replay (`docs/core/protocol.md`, `docs/core/communication.md`).
- Route behavior, auth semantics (`docs/specs/20260704-remote_auth_credential_bootstrap.md`), or any endpoint's business contract.
- The gateway's OpenAI-compatible `/v1/*` surface, which follows external OpenAI compatibility (`docs/specs/20260526-llm_gateway_responses_api.md`), not this projection.

## Core References

- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/contract-evolution.md`
- `docs/core/architecture.md`

## Summary

The App API contract already lives in shared Zod schema packages consumed by NanoCore and the Web SPA through `@openkit/core-client`; the accepted Agent Skill Interface will consume the same public contract through its bundled CLI. What is missing is a machine-readable, framework-neutral description of the public App API surface for external integrators, contract fixtures, documentation, and future non-TypeScript SDKs.

This spec adds an OpenAPI document as a generated projection with the direction fixed: Zod schemas in the shared packages define payload contracts; one canonical operation catalog owns documented route identity and metadata; runtime route registration selects the same operation by id; and build/CI commands reproducibly emit and check the document. Handler runtime parsing still imports the shared schemas directly rather than running through OpenAPI. The projection direction is never inverted — no code, type, or client is generated from the OpenAPI document into first-party packages, and `@openkit/core-client` remains the only first-party SDK.

## Goals / Non-goals

### Goals

- Produce a complete, always-current OpenAPI description of the public App API without introducing a second contract source.
- Make runtime route identity and documented operation metadata select the same catalog entry while keeping payload schemas canonical in the shared packages.
- Detect contract drift and route-coverage gaps mechanically in CI.
- Give external consumers and future non-TS SDK generation a stable artifact.
- Document authentication schemes and the shared error envelope once, referenced everywhere.

### Non-goals

- Do not adopt OpenAPI-first design or generate first-party TypeScript types or clients from the document.
- Do not replace or wrap `@openkit/core-client`; no second first-party SDK.
- Do not make OpenAPI the owner of streaming semantics; the protocol docs own the event envelope.
- Do not pull the separate Core HTTP/SSE projection into the App API document merely because NanoCore serves both surfaces.
- Do not cover the OpenAI-compatible gateway `/v1/*` surface, the direct worker-control `/api/worker-control` contract, or the accepted future `capability.local` plane; those follow their own external or worker-facing contracts.
- Do not add an OpenAPI binding dependency or runtime validation layer without a concrete need that justifies its behavior and maintenance cost.

## Background

The current stack is Hono in `apps/nanocore/src/app.ts`, Zod schemas in `packages/app-api-schemas` and `packages/protocol`, and `@openkit/core-client` as the typed HTTP and SSE client consumed by both `apps/web` and `mcp/`. This is the correct shape per the repository's own governance: one canonical definition, projections elsewhere. `packages/protocol` already generates JSON Schema outputs under the same discipline.

Two alternatives were considered and rejected for the consumer-facing question this spec answers. OpenAPI-first (define the API in OpenAPI, generate Zod and types) inverts the source-of-truth direction, loses Zod expressiveness (discriminated unions, refinements, brands), and produces worse generated types than hand-owned schemas. Hono RPC (`hc` type inference) couples clients to server internals across the core/client boundary that `docs/specs/20260528-core_client_boundary.md` explicitly forbids crossing, and serves no non-TypeScript consumer.

What remains valuable from the OpenAPI ecosystem is the document itself — as an output. Zod v4 ships native JSON Schema conversion, and Hono exposes the registered route table needed for coverage checks, so a small local projection can reuse the schemas and runtime framework the repository already owns.

## Decision

- The shared Zod schema packages (`packages/app-api-schemas`, `packages/protocol`) remain the single contract source for the App API. This spec changes nothing about their authority.
- Every public App API route is registered by a catalog operation id. The catalog owns the documented method, path, request and response schema references, error envelope, security posture, and tags; handler runtime validation continues to import the owning shared schemas directly.
- An OpenAPI 3.1 document is reproducibly generated from the catalog by build and CI commands, committed for review, drift-checked, and also instantiated once at server module load for diagnostic serving.
- The document is a projection: read-only, never hand-edited, never a codegen source for first-party TypeScript packages.
- `@openkit/core-client` remains the only first-party SDK; MCP and the Web SPA continue to consume it.

## Contract / Expected Behavior

### Source-of-truth direction

- Zod schemas in the shared packages MUST remain the canonical App API payload contracts. The OpenAPI document MUST be fully derivable from the canonical operation catalog plus those schemas.
- The OpenAPI document MUST NOT be hand-edited. Every change to it MUST originate from a shared-schema or canonical-catalog change.
- First-party TypeScript packages MUST NOT consume the OpenAPI document for types, validation, or client generation. `@openkit/core-client` imports schemas from the shared packages directly, as it does today.
- The document MAY be consumed by: external integrators, L2 contract fixtures, API documentation surfaces, and future non-TypeScript SDK generation. A generated non-TS SDK is an external consumer artifact, not a first-party contract owner.

### Route registration

- Every public App API route MUST be registered with: path, method, operation id, request schema references (params, query, body), response schema references per status code, error envelope reference, required auth scheme, and tags.
- Reusable structured request and response shapes MUST import from the shared packages. A route-local primitive path or query constraint MAY remain inline when no shared semantic schema exists and extracting one would create a speculative contract entity; when a shared id or value schema already exists, the registration MUST reference it instead of duplicating the constraint.
- Operation ids MUST be stable, unique, lowercase-camel identifiers; they become anchor points for fixtures and external SDKs, and renaming one is a contract change.
- Routes explicitly outside the projection are a closed list: the Core HTTP/SSE projection, browser-auth implementation routes, the OpenAI-compatible `/v1/*` gateway surface, worker-plane relay routes (`/api/worker-control/*`), deterministic local-mode test-support routes, and internal diagnostics explicitly marked non-public. Every public App API route outside that list MUST be registered.

### Generated document

- The document MUST target OpenAPI 3.1 (JSON Schema aligned) and be reproducibly emitted by the build command. NanoCore MAY instantiate the same pure projection once at module load, but MUST NOT rebuild it per request, derive it from runtime reflection, or live-fetch it.
- The document MUST carry: the App API version identifier, the protocol version it corresponds to (per `docs/core/protocol.md` versioning), and a projection-content digest so copies of the same generated projection can be compared exactly. The digest is not a source-file or commit identifier.
- Authentication MUST be documented as security schemes matching `docs/specs/20260704-remote_auth_credential_bootstrap.md`: bearer token (`okt_` tokens) and the session-cookie path, applied per route.
- The shared error envelope MUST be registered once as a component and referenced by every route's error responses; per-route error documentation adds typed codes, not new envelope shapes.
- NanoCore MUST serve the generated App API document at a stable diagnostic route (implementation projection: `/api/openapi.json`), gated by the same auth posture as other diagnostics read models. A human-readable documentation UI MAY be mounted in development builds; it is not a product surface commitment.

### SSE and streaming routes

- OpenAPI cannot express the event envelope, ordering, cursor, and replay semantics that `docs/core/protocol.md` and `docs/core/communication.md` own. The projection MUST NOT attempt to become that owner.
- The current turn-scoped SSE route is part of the separate Core HTTP/SSE projection and therefore MUST NOT be added to the App API document. Its schemas, cursor behavior, and client implementation remain governed by `@openkit/protocol` and `@openkit/core-client`.
- If a future App API-owned route streams, it MUST appear in this document with its negotiated content type, a vendor extension (`x-openkit-sse`) naming the event families and protocol documentation, and component schemas imported from the owning shared schema package. That conditional rule does not transfer Core stream ownership to the App API.

### Drift and coverage checks

- L0 drift check: CI regenerates the document and fails on any diff against the committed or previously built artifact. A schema change that alters the document is visible in review as a document diff.
- L0 coverage check: CI compares the live Hono route table against registered operations and fails when a public route is unregistered or a registered operation has no live route. The closed exclusion list above is the only allowed difference.
- The generated document MUST validate against the OpenAPI 3.1 meta-schema in CI.

### Migration discipline

- Route conversion to registered form proceeds route-group by route-group, but per the internal development compatibility rule the end state is total: once the coverage check is enabled, no public route may bypass registration, and no parallel unregistered route style remains.

## Accepted Design

The accepted implementation is a small OpenKit-owned registry over Hono and Zod v4's native `z.toJSONSchema` conversion. One canonical App API catalog owns each operation id, method, path, shared-schema references, responses, security posture, and tags. Runtime route registration supplies the operation id and handler, then derives the Hono method and path from that same catalog; the generated document projects the same catalog instead of maintaining a second route identity list. Metadata may move into cohesive API-area modules as feature paths are decomposed, but the implementation must not create one wrapper or file per route. Generation runs as a build script in `apps/nanocore`, and the drift check re-runs that script in CI. No OpenAPI binding dependency or runtime response-validation layer is required unless a later concrete need justifies its behavior and maintenance cost.

## Current Implementation Projection

NanoCore now builds one process-wide OpenAPI 3.1 document in `apps/nanocore/src/openapi.ts` from the canonical operation catalog and shared Zod schemas. Every documented runtime operation registers through `registerAppApiRoute` by operation id, so its method and Hono path come from the same catalog as the generated document. `GET /api/openapi.json` serves the cached document rather than rebuilding it per request. The document identifies App API version `0.1.0`, records the current Core protocol version separately in `x-openkit-protocol-version`, and carries `x-openkit-source-digest` over its version, paths, and components.

The focused L0 suite compares the default app's explicit GET, POST, PUT, PATCH, and DELETE route entries with the documented operation set in both directions, rejects duplicate or unsupported App API registrations, and requires every inspected route to fall into either the App API projection or a closed non-App classification. Middleware, Hono `ALL` entries, and conditionally mounted browser-auth routes remain covered by their owning tests rather than this catalog gate. The suite also enforces unique lower-camel operation ids, explicit route security, a shared default `ApiError`, resolvable component references, selected shared-schema fidelity, and canonical Core id parameter fidelity. The generated artifact is committed at `apps/nanocore/openapi/app-api.openapi.json`; `openapi:generate`, `openapi:validate`, and `openapi:check` enforce reproducibility, official OpenAPI 3.1 validation, and drift. First-party consumers remain prohibited from treating the artifact as a contract source, and `@openkit/core-client` remains the only first-party SDK.

## Alternatives Considered

- OpenAPI-first with generated Zod/types. Rejected: inverts source-of-truth, loses schema expressiveness, generates worse types, and contradicts the repository's canonical-definition governance.
- Hono RPC (`hc`) type inference as the client contract. Rejected: crosses the core/client boundary by coupling consumers to server internals, is monorepo-only, and serves no non-TS consumer.
- Generating a second TypeScript SDK from the OpenAPI document. Rejected: two first-party SDKs guarantee drift; `core-client` already exists and handles SSE, which OpenAPI-generated clients do poorly.
- Status quo with no OpenAPI artifact. Rejected: external consumers, fixtures, and future non-TS SDKs would each reverse-engineer the surface; the marginal cost of the projection is low because the schemas already exist.
- TypeSpec or Smithy as an IDL layer. Rejected: adds a third schema language above Zod for no expressiveness gain at this scale.

## Consequences

- Every public App API route gains a registration obligation; forgetting it is a CI failure, not a documentation gap discovered later.
- Schema changes become reviewable as OpenAPI diffs, which doubles as a human-readable contract changelog.
- External integrators and future non-TS SDKs get a stable artifact without any new contract authority being created.
- The repository takes on one small projection module, generation script, official validation schema, and committed artifact as maintenance surface; it adds no OpenAPI binding dependency.

## Rollout / Migration Plan

1. Select Zod v4's native JSON Schema conversion and a small OpenKit-owned catalog instead of adding a binding dependency.
2. Land the registry, generation script, document serving route, and the L0 drift check with the first converted route group.
3. Convert remaining route groups; new routes from the 20260704 specs land pre-registered.
4. Enable the L0 coverage check, closing the registration obligation.
5. Wire the document into L2 contract fixtures where useful.

No compatibility path is kept for unregistered public routes once the coverage check is enabled.

## Testing Strategy / Acceptance Criteria

Mapped to `docs/specs/20260529-test_strategy.md`:

- L0: drift check (regeneration produces no diff); coverage check (the default app's explicit supported-method route entries equal registered operations modulo the closed exclusion list); OpenAPI 3.1 meta-schema validation.
- L1: unit tests for the registry (schema reference resolution, operation id uniqueness, security scheme application) and, if an App API-owned streaming route is introduced, its SSE vendor-extension emission.
- L2: selected component projections equal the JSON Schema generated directly from their source Zod schemas, and every operation references the shared error envelope.
- L3: server-level request test that the diagnostic route returns the document, it parses, and its version identifiers match the running build.
- L5: built-process smoke that starts `dist/index.js` and verifies the module-level document is served with both version identifiers and a SHA-256-formatted projection digest. The review artifact remains under `openapi/`; it is not duplicated into `dist/`.

Acceptance: coverage and drift checks green with all public route groups converted; no first-party package imports anything generated from the document; the document validates and is served.

## Risks & Mitigations

- Risk: Zod JSON Schema conversion changes across upgrades. Mitigation: the committed artifact, selected schema-fidelity assertions, official OpenAPI validation, and drift gate make projection changes explicit in review.
- Risk: projection fidelity gaps (Zod constructs OpenAPI cannot express) silently weaken the document. Mitigation: selected projection-fidelity assertions and artifact review make current mappings explicit; any observed unsupported construct must gain a focused failing fidelity test before its projection is accepted.
- Risk: the document drifts into being treated as the contract by new contributors. Mitigation: the source-of-truth direction is stated in the document's own `info.description` and enforced by the no-codegen-into-first-party rule at L0 (import lint).
- Risk: registration ceremony slows route development. Mitigation: runtime registration supplies only an operation id and handler, shared metadata stays in one catalog, and the coverage check converts forgetting into an immediate local failure.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: the generated OpenAPI document is committed to the repository for reviewable diffs and L0 drift checks; no human-readable documentation UI is shipped in V1.

## Deferred / Future Work

- Non-TypeScript SDK generation (Python first) from the document for external consumers.
- Publishing the document as part of release artifacts for external integrators.
- An optional development-only documentation UI behind an explicit flag, if direct artifact inspection becomes insufficient.
- Extending the projection discipline to a machine-readable description of the MCP tool surface if external demand appears.

## Links

- `docs/specs/20260528-core_client_boundary.md`
- `docs/specs/20260628-protocol_contract_consolidation.md`
- `docs/specs/20260704-remote_auth_credential_bootstrap.md`
- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/contract-evolution.md`
- `docs/app-api.md`
