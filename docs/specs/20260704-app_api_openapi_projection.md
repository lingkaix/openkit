# App API OpenAPI Projection

Status: Accepted
Implementation: Implemented

## Owns

- The rule that the shared Zod schema packages remain the single contract source for the App API, and that OpenAPI is a generated projection, never a source.
- The binding contract between App API routes and shared-package schemas: every public route registers its request, response, and error shapes from the shared packages.
- The generated OpenAPI document: generation discipline, versioning, serving route, and drift control.
- The SSE documentation rule: how streaming routes appear in the OpenAPI projection without OpenAPI becoming the streaming contract owner.
- Consumption rules: what the OpenAPI document may and may not be used for, including the one-first-party-SDK rule.
- Route coverage completeness checking.

## Does Not Own

- Schema contents and their package boundaries. `packages/protocol` and `packages/app-api-schemas` own their schemas; `docs/specs/20260628-protocol_contract_consolidation.md` and `docs/specs/20260528-core_client_boundary.md` own the layering.
- The `@openkit/core-client` SDK design and sub-client composition (`docs/specs/20260528-core_client_boundary.md`).
- Protocol event envelope, SSE semantics, stream cursors, and replay (`docs/core/protocol.md`, `docs/core/communication.md`).
- Route behavior, auth semantics (`docs/specs/20260704-remote_auth_credential_bootstrap.md`), or any endpoint's business contract.
- The gateway's OpenAI-compatible `/v1/*` surface, which follows external OpenAI compatibility (`docs/specs/20260526-llm_gateway_responses_api.md`), not this projection.

## Core References

- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/contract-evolution.md`
- `docs/core/architecture.md`

## Summary

The App API contract already lives in shared Zod schema packages consumed by NanoCore, the Web SPA, and the MCP channel through `@openkit/core-client`. What is missing is a machine-readable, framework-neutral description of the HTTP surface for everything that is not a first-party TypeScript consumer: external integrators, contract fixtures, documentation, and future non-TypeScript SDKs.

This spec adds an OpenAPI document as a generated projection with the direction fixed: Zod schemas in the shared packages define the contract; App API routes bind to those schemas through an OpenAPI-aware route registry; the OpenAPI document is generated from that registry at build time, checked for drift in CI, and served as a diagnostic artifact. The projection direction is never inverted — no code, type, or client is generated from the OpenAPI document into first-party packages, and `@openkit/core-client` remains the only first-party SDK.

## Goals / Non-goals

### Goals

- Produce a complete, always-current OpenAPI description of the public App API without introducing a second contract source.
- Make route registration carry its schemas from the shared packages so runtime validation, static types, and documentation derive from one definition.
- Detect contract drift and route-coverage gaps mechanically in CI.
- Give external consumers and future non-TS SDK generation a stable artifact.
- Document authentication schemes and the shared error envelope once, referenced everywhere.

### Non-goals

- Do not adopt OpenAPI-first design or generate first-party TypeScript types or clients from the document.
- Do not replace or wrap `@openkit/core-client`; no second first-party SDK.
- Do not make OpenAPI the owner of streaming semantics; the protocol docs own the event envelope.
- Do not cover the OpenAI-compatible gateway `/v1/*` surface or the worker-visible `control.local` and `capability.local` planes; those follow their own external or worker-facing contracts.
- Do not commit to one specific binding library as contract; the library is an implementation projection.

## Background

The current stack is Hono in `apps/nanocore/src/app.ts`, Zod schemas in `packages/app-api-schemas` and `packages/protocol`, and `@openkit/core-client` as the typed HTTP and SSE client consumed by both `apps/web` and `mcp/`. This is the correct shape per the repository's own governance: one canonical definition, projections elsewhere. `packages/protocol` already generates JSON Schema outputs under the same discipline.

Two alternatives were considered and rejected for the consumer-facing question this spec answers. OpenAPI-first (define the API in OpenAPI, generate Zod and types) inverts the source-of-truth direction, loses Zod expressiveness (discriminated unions, refinements, brands), and produces worse generated types than hand-owned schemas. Hono RPC (`hc` type inference) couples clients to server internals across the core/client boundary that `docs/specs/20260528-core_client_boundary.md` explicitly forbids crossing, and serves no non-TypeScript consumer.

What remains valuable from the OpenAPI ecosystem is the document itself — as an output. Zod v4 ships native JSON Schema conversion, and Hono has OpenAPI-aware route layers, so the projection can be generated from the schemas the repository already owns.

## Decision

- The shared Zod schema packages (`packages/app-api-schemas`, `packages/protocol`) remain the single contract source for the App API. This spec changes nothing about their authority.
- Every public App API route is registered through an OpenAPI-aware route registry that binds the route to request, response, and error schemas imported from the shared packages.
- An OpenAPI 3.1 document is generated from the registry at build time, committed or reproducibly built, drift-checked in CI, and served by NanoCore as a diagnostic artifact.
- The document is a projection: read-only, never hand-edited, never a codegen source for first-party TypeScript packages.
- `@openkit/core-client` remains the only first-party SDK; MCP and the Web SPA continue to consume it.

## Contract / Expected Behavior

### Source-of-truth direction

- Zod schemas in the shared packages MUST remain the canonical App API contract. The OpenAPI document MUST be fully derivable from route registrations plus those schemas.
- The OpenAPI document MUST NOT be hand-edited. Every change to it MUST originate from a schema or route-registration change.
- First-party TypeScript packages MUST NOT consume the OpenAPI document for types, validation, or client generation. `@openkit/core-client` imports schemas from the shared packages directly, as it does today.
- The document MAY be consumed by: external integrators, L2 contract fixtures, API documentation surfaces, and future non-TypeScript SDK generation. A generated non-TS SDK is an external consumer artifact, not a first-party contract owner.

### Route registration

- Every public App API route MUST be registered with: path, method, operation id, request schema references (params, query, body), response schema references per status code, error envelope reference, required auth scheme, and tags.
- Schema references in registrations MUST import from the shared packages. Inline anonymous schemas in route registrations are prohibited for anything that appears in a public payload; a shape needed by a route belongs in `packages/app-api-schemas` first.
- Operation ids MUST be stable, unique, lowercase-camel identifiers; they become anchor points for fixtures and external SDKs, and renaming one is a contract change.
- Routes explicitly outside the projection are a closed list: the OpenAI-compatible `/v1/*` gateway surface, worker-plane relay routes (`/api/worker-control/*`), deterministic local-mode test-support routes, and internal diagnostics explicitly marked non-public. Everything else public MUST be registered.

### Generated document

- The document MUST target OpenAPI 3.1 (JSON Schema aligned), generated at build time — never assembled by runtime reflection on demand and never live-fetched from anywhere.
- The document MUST carry: the App API version identifier, the protocol version it corresponds to (per `docs/core/protocol.md` versioning), and a generation source digest so any copy can be traced to the schema state that produced it.
- Authentication MUST be documented as security schemes matching `docs/specs/20260704-remote_auth_credential_bootstrap.md`: bearer token (`okt_` tokens) and the session-cookie path, applied per route.
- The shared error envelope MUST be registered once as a component and referenced by every route's error responses; per-route error documentation adds typed codes, not new envelope shapes.
- NanoCore MUST serve the generated document at a stable App API route (implementation projection: `/api/openapi.json`), gated by the same auth posture as other diagnostics read models. A human-readable documentation UI MAY be mounted in development builds; it is not a product surface commitment.

### SSE and streaming routes

- OpenAPI cannot express the event envelope, ordering, cursor, and replay semantics that `docs/core/protocol.md` and `docs/core/communication.md` own. The projection MUST NOT attempt to become that owner.
- Streaming routes MUST still appear in the document: registered with their negotiated content type, the event envelope component schema as the payload description, and a vendor extension (`x-openkit-sse`) carrying the event family names and a pointer to the protocol documentation.
- The event envelope and event family schemas referenced this way MUST come from `packages/protocol` exports, so the streaming shapes in the document are the same shapes the protocol owns.

### Drift and coverage checks

- L0 drift check: CI regenerates the document and fails on any diff against the committed or previously built artifact. A schema change that alters the document is visible in review as a document diff.
- L0 coverage check: CI compares the live Hono route table against registered operations and fails when a public route is unregistered or a registered operation has no live route. The closed exclusion list above is the only allowed difference.
- The generated document MUST validate against the OpenAPI 3.1 meta-schema in CI.

### Migration discipline

- Route conversion to registered form proceeds route-group by route-group, but per the internal development compatibility rule the end state is total: once the coverage check is enabled, no public route may bypass registration, and no parallel unregistered route style remains.

## Accepted Design

The registry is a thin layer over Hono: a route-definition module per API area (workspaces, threads, goal mode, action center, artifacts, runtime config, auth, and the surfaces added by the 20260704 specs — readiness diagnostics, token administration, vault unlock, export/import, push records, MCP catalog) that pairs each handler with its schema imports and OpenAPI metadata. Candidate bindings are `@hono/zod-openapi` or `hono-openapi`, with Zod v4's native `z.toJSONSchema` as the conversion substrate; the choice is an implementation projection to be settled by a spike, because the contract above is deliberately satisfiable by any of them — or by a small OpenKit-owned generator if the libraries fight Zod v4. Generation runs as a build script in `apps/nanocore` emitting the document into the package build output; the drift check re-runs the script in CI.

## Current Implementation Projection

The first projection slice is implemented in NanoCore. `apps/nanocore/src/openapi.ts` creates an OpenAPI 3.1 document from shared Zod schemas with Zod v4 JSON Schema conversion, and `GET /api/openapi.json` serves that document. Registered operations currently include `GET /api/app/storage/layout-report`, app/setup diagnostics, runtime config reload/file/schema/validation routes, OpenAI Codex OAuth account list/create/update/delete/status/start/cancel/logout routes, agent catalog list/detail, dashboard and Action Center read models, thread item-log read model, artifact/knowledge/goal review decisions, automation list/create/update/delete, agent health refresh, quick chat, active agent-session terminal command queueing, interrupted worker recovery list, pending user-turn recovery read/edit/follow-up/interrupt/cancel operations, deterministic interrupted-worker recovery state creation, interrupted-worker terminal checkpoint cleanup and retry, app search, turn feedback, Chat Mode start, Task Mode start, Goal Mode summary/start/steering/plan/approval/revision/step routes, Knowledge Manager answer/context/proposal/repair routes, workspace synchronization review/input/materialization/change-set/staged-review/apply-result read models, data-root backup create/verify, workspace export/import/dry-run import, vault admin status/unlock/lock/Codex auth bootstrap, imported workspace vault reference rebind, workspace repository resource list/diagnostics/default setup, and Git push record/approval/execution routes, with response/request schemas from `@openkit/app-api-schemas`, `ApiErrorSchema` from `@openkit/protocol`, and the accepted bearer-token/session-cookie security schemes.

Public App API route registration is covered by a focused route-coverage unit check over the projected `/api/app`, `/api/setup`, `/api/admin`, and `/api/turns` feedback route families, with a closed deterministic-test-support exclusion list. The generated artifact is committed at `apps/nanocore/openapi/app-api.openapi.json`, carries `x-openkit-source-digest`, `pnpm --filter @openkit/nanocore run openapi:generate` regenerates it, `pnpm --filter @openkit/nanocore run openapi:validate` validates it against the committed official OpenAPI 3.1 schema, and `pnpm --filter @openkit/nanocore run openapi:check` enforces generation, validation, and artifact drift. The L0 test suite also scans `@openkit/core-client`, `apps/web`, and `mcp` source files to prevent first-party consumers from reading the generated artifact or treating it as a contract source. `@openkit/core-client` remains the only first-party SDK and does not consume the OpenAPI document.

## Alternatives Considered

- OpenAPI-first with generated Zod/types. Rejected: inverts source-of-truth, loses schema expressiveness, generates worse types, and contradicts the repository's canonical-definition governance.
- Hono RPC (`hc`) type inference as the client contract. Rejected: crosses the core/client boundary by coupling consumers to server internals, is monorepo-only, and serves no non-TS consumer.
- Generating a second TypeScript SDK from the OpenAPI document. Rejected: two first-party SDKs guarantee drift; `core-client` already exists and handles SSE, which OpenAPI-generated clients do poorly.
- Status quo with no OpenAPI artifact. Rejected: external consumers, fixtures, and future non-TS SDKs would each reverse-engineer the surface; the marginal cost of the projection is low because the schemas already exist.
- TypeSpec or Smithy as an IDL layer. Rejected: adds a third schema language above Zod for no expressiveness gain at this scale.

## Consequences

- Every public route gains a registration obligation; forgetting it is a CI failure, not a documentation gap discovered later.
- Schema changes become reviewable as OpenAPI diffs, which doubles as a human-readable contract changelog.
- External integrators and future non-TS SDKs get a stable artifact without any new contract authority being created.
- The repository takes on one generation script and its binding library as maintenance surface; the contract's library-agnosticism bounds the exit cost if the binding churns.

## Rollout / Migration Plan

1. Spike the binding choice against Zod v4 on one route group; settle the implementation projection.
2. Land the registry, generation script, document serving route, and the L0 drift check with the first converted route group.
3. Convert remaining route groups; new routes from the 20260704 specs land pre-registered.
4. Enable the L0 coverage check, closing the registration obligation.
5. Wire the document into L2 contract fixtures where useful.

No compatibility path is kept for unregistered public routes once the coverage check is enabled.

## Testing Strategy / Acceptance Criteria

Mapped to `docs/specs/20260529-test_strategy.md`:

- L0: drift check (regeneration produces no diff); coverage check (route table equals registered operations modulo the closed exclusion list); OpenAPI 3.1 meta-schema validation.
- L1: unit tests for the registry (schema reference resolution, operation id uniqueness, security scheme application) and for SSE vendor-extension emission.
- L2: contract tests that sampled generated component schemas accept and reject the same fixtures as their source Zod schemas (projection fidelity spot checks); error envelope referenced by every operation.
- L3: black-box test that the serving route returns the document, it parses, and its version identifiers match the running build.
- L5: packaged-build smoke that the document is present in build output and served.

Acceptance: coverage and drift checks green with all public route groups converted; no first-party package imports anything generated from the document; the document validates and is served.

## Risks & Mitigations

- Risk: the binding library lags Zod major versions. Mitigation: the contract is library-agnostic; Zod v4's native JSON Schema conversion keeps an OpenKit-owned generator viable as the fallback.
- Risk: projection fidelity gaps (Zod constructs OpenAPI cannot express) silently weaken the document. Mitigation: L2 fidelity spot checks; constructs that cannot project MUST emit a generation warning naming the schema, not silently degrade.
- Risk: the document drifts into being treated as the contract by new contributors. Mitigation: the source-of-truth direction is stated in the document's own `info.description` and enforced by the no-codegen-into-first-party rule at L0 (import lint).
- Risk: registration ceremony slows route development. Mitigation: the registry is one import and one metadata object per route; the coverage check converts forgetting into an immediate, local failure.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: the generated OpenAPI document is committed to the repository for reviewable diffs and L0 drift checks; development documentation UI is available only behind an explicit development flag and is not mounted permanently by default.

## Deferred / Future Work

- Non-TypeScript SDK generation (Python first) from the document for external consumers.
- Publishing the document as part of release artifacts for external integrators.
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
