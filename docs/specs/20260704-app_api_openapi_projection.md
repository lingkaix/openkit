---
status: Accepted
implementation: Partial
kind: boundary
aspect: protocol
---
# App API OpenAPI Projection

This specification is the single owner of the generated OpenAPI 3.1 projection of the public App API, its route registration and exclusion boundary, its diagnostic serving route, and its drift and coverage checks.

## Scope

Owns the rule that shared Zod schema packages are the sole contract source for the App API while OpenAPI is a generated read-only projection, the projection of composed operation definitions and non-JSON streaming/binary routes into OpenAPI 3.1, the `/api/openapi.json` diagnostic route, streaming-route documentation rules, consumption restrictions, and route-coverage and drift checks.

Does not own:
- Shared schema contents, operation definitions, or `@openkit/core-client` SDK design ([Core Client Boundary](20260528-core_client_boundary.md), [Operation Definition](20261002-operation_definition.md)).
- Core metadata (`/api/meta`), Thread SSE (`/api/workspaces/:workspaceId/threads/:threadId/events`), event envelope, or stream cursor semantics ([Protocol](../core/protocol.md), [Communication](../core/communication.md), [Core Client Boundary](20260528-core_client_boundary.md)).
- Authentication procedures ([Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md)) or the OpenAI-compatible `/v1/*` gateway ([LLM Gateway](20260526-llm_gateway_responses_api.md)).
- Worker-plane and NanoHost transport routes ([NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md)).

Core: [Protocol](../core/protocol.md), [Communication](../core/communication.md), [Contract Evolution](../core/contract-evolution.md), [Architecture](../core/architecture.md).

## Source-Of-Truth Direction

- Zod schemas in `@openkit/app-api-schemas` and `@openkit/protocol` MUST remain the canonical App API payload contracts. Handler runtime validation imports those shared schemas directly rather than running through OpenAPI.
- The OpenAPI document MUST be derived from the composed operation definition tables ([Operation Definition](20261002-operation_definition.md)) and registered non-JSON streaming/binary route descriptors plus the shared Zod schemas. A schema view derived from an operation definition is not a second contract.
- Generated JSON Schema and OpenAPI components MUST retain every representable structural constraint from their canonical schemas. A cross-field comparison that standard JSON Schema cannot express remains authoritative in the canonical Zod schema, and the generated component MUST describe that receiver boundary rather than imply semantic parity.
- The OpenAPI document MUST NOT be hand-edited. Every change to it MUST originate from a shared-schema or operation-definition change.
- First-party TypeScript packages MUST NOT consume the OpenAPI document for types, validation, or client generation. `@openkit/core-client` remains the only first-party SDK; the Web SPA and administrator CLI consume it, while remote MCP invokes the shared operations natively.
- The document MAY be consumed by same-release L2 contract fixtures, API documentation surfaces, release diagnostics, and developer inspection. Any external use is pinned to the exact OpenKit version and carries no cross-release compatibility promise.

## Route Registration

- Every public App API route MUST be registered with its path, HTTP method, canonical operation id, request schema references (params, query, body), response schema references per status code, shared error envelope reference, required authentication scheme, and tags.
- JSON product operations derive their `POST /api/app/operations/<id>` HTTP route, request/response component schemas, and allowed status codes directly from `OPERATION_DEFINITIONS` in `packages/app-api-schemas/src/operation-definitions.ts`. A JSON operation that declares HTTP `204` omits response body content in the generated OpenAPI response entry. The retired `chat.quick` operation is absent.
- Non-JSON streaming and binary routes retain their canonical operation ids and explicit raw-body or stream response documentation: `workspace.archive-download` and the two Workspace snapshot download bindings under [Workspace Backup, Export, And Import](20260704-workspace_backup_export_import.md), `artifact.import`, `artifact.version-file-commit`, and `artifact.download` under [Work Resource Interaction](20260713-work_resource_interaction_model.md), and the Knowledge package operations under [File Storage And Knowledge Packages](20261018-file_storage_and_knowledge_packages.md). Ordinary portable Workspace archive import is absent. Their OpenAPI entries MUST NOT advertise JSON file bytes.
- Reusable structured request and response shapes MUST import from the shared packages. A route-local primitive path or query constraint MAY remain inline when no shared semantic schema exists; when a shared identifier or value schema exists, registration MUST reference it instead of duplicating the constraint.
- Routes explicitly outside the App API OpenAPI projection are a closed list:
  - The Core HTTP/SSE projection (`/api/meta` and `/api/workspaces/:workspaceId/threads/:threadId/events`), owned by [Core Client Boundary](20260528-core_client_boundary.md).
  - Browser-auth implementation routes, owned by [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md).
  - The OpenAI-compatible `/v1/*` gateway, owned by [LLM Gateway](20260526-llm_gateway_responses_api.md).
  - Worker-plane (`/worker-control/*`, `/inference/*`, `/capabilities/*`) and NanoHost transport routes, owned by [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md).
  - Discord interactions ingress, owned by [Pending Requests](20260930-pending_requests.md).
  - Health and diagnostic support bindings (`/health`, `/api/health`, `/api/diagnostics`), owned by [NanoCore Bootstrap Readiness](20260704-nanocore_bootstrap_readiness.md), plus `/api/openapi.json`.
- Every public App API route outside that closed list MUST be registered.

## Generated Document

- The document MUST target OpenAPI `3.1.0` (JSON Schema aligned) and be reproducibly emitted by build and CI commands (`openapi:generate`, `openapi:validate`, `openapi:check`). NanoCore instantiates the same pure projection once at module load and MUST NOT rebuild it per request, derive it from runtime reflection, or live-fetch it.
- The document MUST carry App API version `0.1.0` in `info.version`, the active Core protocol version in `x-openkit-protocol-version`, the operation stability map for the entire `OPERATION_REGISTRY` (including native non-API descriptors without creating HTTP routes) in `x-openkit-operation-stability`, and a projection-content digest in `x-openkit-source-digest`.
- `x-openkit-source-digest` is `sha256:` followed by the lowercase hexadecimal SHA-256 of the insertion-order JSON object `{components, info, openapi, paths, protocolVersion, operationStability}` under the named exception in [Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md#canonical-structured-value-digests). These fields identify an exact contract set and do not promise cross-version compatibility.
- Authentication MUST be documented as security schemes matching [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md): bearer token (`okt_` tokens) and session cookie, applied per route.
- The shared `ApiError` error envelope MUST be registered once as a component and referenced by every route's error responses; per-route error documentation adds typed codes rather than new envelope shapes.
- NanoCore MUST serve the generated App API document at `GET /api/openapi.json` to authenticated readers. The document MUST contain no secrets. No human-readable documentation UI is shipped in V1.

## SSE And Streaming Routes

- OpenAPI does not own the event envelope, ordering, cursor, or replay semantics owned by [Protocol](../core/protocol.md) and [Communication](../core/communication.md).
- The Thread event stream route belongs to the separate Core HTTP/SSE projection and MUST NOT be added to the App API OpenAPI document.
- If a future App API-owned route streams events, it MUST appear in this document with its negotiated content type, an `x-openkit-sse` vendor extension naming the event families and protocol documentation, and component schemas imported from the owning shared schema package.

## Drift And Coverage Checks

- L0 drift check: CI regenerates the OpenAPI document and fails on any diff against the committed artifact (`apps/nanocore/openapi/app-api.openapi.json`).
- L0 coverage check: CI compares the default app's explicit `GET`, `POST`, `PUT`, `PATCH`, and `DELETE` route entries against the documented operation set in both directions, rejects duplicate or unsupported registrations, and fails if any route falls outside the App API projection and the closed exclusion list above.
- L0 import lint MUST enforce the no-codegen-into-first-party rule so first-party packages never import types, validators, or clients generated from the OpenAPI document. `apps/nanocore/src/openapi.test.ts` currently scans only Web, Core Client, and skills source for two generated-artifact path substrings. That scan does not enforce imports of arbitrary OpenAPI-generated types, validators, or clients across first-party packages. `biome.json` has no restricted-import rule for this case. `scripts/check-structure.mjs` gates shared primitives and import cycles, not this rule. The L0 commands add no such lint.
- The generated document MUST validate against the official OpenAPI 3.1 meta-schema in CI.

## Agent Use Of Public Read Projections

The App search and Workspace/Thread dashboard read models are shared operation projections: the administrator CLI consumes `@openkit/core-client` and remote MCP invokes those operations natively using the same shared schemas. Their handlers enforce current Workspace access and the accepted Thread and Artifact origin audience rules under [Thread Visibility And Sharing](20260909-thread_visibility_and_sharing.md) and Administrator Eligibility in [Policy](../core/policy.md) before dependent discovery: a currently usable administrator credential receives Administrator Eligibility for private Thread and Artifact audience filtering, whereas an ordinary administration entry path alone grants no additional private audience.

## Acceptance

- L1: registry validation verifies component reference resolution, operation id uniqueness, security scheme application, and canonical Core identifier parameter fidelity.
- L2: selected component projections equal the JSON Schema generated directly from their source Zod schemas, and every operation references the shared `ApiError` component. Any observed unsupported Zod construct that OpenAPI cannot express MUST gain a focused failing fidelity test before its projection is accepted.
- L3: an authenticated request to `GET /api/openapi.json` returns the valid OpenAPI 3.1 document with matching App API and protocol version identifiers.
- L5: a built-process smoke test starting `dist/index.js` verifies that `GET /api/openapi.json` serves the module-level document with both version identifiers, `x-openkit-operation-stability`, and a `sha256:`-prefixed `x-openkit-source-digest`, without duplicating the review artifact into `dist/`.

## Implementation

- `packages/app-api-schemas/src/`
- `packages/protocol/src/`
- `apps/nanocore/src/`
- `apps/nanocore/openapi/`

## Implementation Gaps

- L0 import lint MUST enforce the no-codegen-into-first-party rule - The current guard scans only Web, Core Client, and skills source for two generated-artifact path substrings and does not lint arbitrary generated imports across first-party packages - #762

## Decisions

- [Retire Stateless Quick Chat](../decisions/20261016-retire_stateless_quick_chat.md)
