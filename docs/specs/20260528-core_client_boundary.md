# Core Client Boundary

Status: Accepted
Implementation: Implemented

## Owns

This spec owns the package boundary between `@openkit/protocol`, `@openkit/app-api-schemas`, `@openkit/core-client`, NanoCore App API routes, and Web UI client consumption.

It owns the composed client surface, schema package split, typed client grouping, transport validation rules, and the removal of flat internal-development aliases.

## Does Not Own

This spec does not own stable core protocol semantics, individual App API route behavior, Web UI screens, NanoCore service implementation, auth internals, runtime config semantics, or worker runtime behavior.

## Core References

- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/work-model.md`
- `docs/core/architecture.md`

## Summary

`@openkit/core-client` is now a composed client instead of a flat mixed protocol and App API client.

Core protocol HTTP and SSE routes live under `client.core`.

NanoCore App API read models and app-local commands live under dedicated sub-clients.

Shared App API payload validation lives in `@openkit/app-api-schemas`, which is imported by both NanoCore and the client.

## Problem

The previous client package defined Core protocol schemas, App API schemas, removed aliases, OAuth payloads, runtime-config schemas, diagnostics schemas, dashboard schemas, and product read models in one file.

That made `@openkit/core-client` the accidental owner of NanoCore App API shapes.

It also forced the Web UI to consume a flat API surface where stable Core semantics and app-local read models were indistinguishable.

## Boundary Ownership

`@openkit/protocol` owns stable Core records, command requests, command responses, event envelopes, error shapes, capability metadata, and conformance fixtures.

`@openkit/app-api-schemas` owns runtime-neutral schemas for NanoCore App API payloads.

`apps/nanocore` owns App API route behavior and parses route output through `@openkit/app-api-schemas`.

`@openkit/core-client` owns transport, response validation, request-id insertion, SSE iteration, and the composed TypeScript client surface.

`apps/web` consumes only the composed client.

## Client Shape

The public client is grouped by boundary:

- `client.core`: meta, workspaces, knowledge, threads, turns, items, approvals, artifacts, and turn SSE.
- `client.app`: dashboards, Goal Mode, workspace synchronization read models, agent-session terminal commands, search, quick chat, automations, diagnostics, setup diagnostics, artifact review, Goal Review, and feedback.
- `client.runtimeConfig`: runtime config file list, read, create, update, validate, reload, and schema catalog routes.
- `client.oauth.openaiCodex`: Codex ChatGPT account slot status, list, create, update, delete, start, cancel, and logout routes.
- `client.auth.email`: Better Auth email sign-up, sign-in, and sign-out routes.
- `client.capabilities`: `refresh`, `snapshot`, `supports`, and `require` helpers over `/api/meta`.
- `client.agents`: Agent Catalog list, get, and health refresh routes.
- `client.actionCenter`: unified Human Attention read-model route.
- `client.repositories`: workspace repository resource list, diagnostics, and default repository setup routes.

Deprecated flat aliases are removed.

There is no `getMeta`, `createMemoryEntry`, `updateMemoryEntry`, `respondToApproval`, `subscribeToTurn`, or `subscribeTurnEvents` method on the root client.

## App API Schema Package

`@openkit/app-api-schemas` exports schema families for dashboards, diagnostics, setup diagnostics, runtime config, OAuth account slots, auth responses, automations, quick chat, search, turn feedback, repository resources, workspace synchronization, Goal Mode read models and decisions, Agent Catalog, and Action Center.

The package depends only on `@openkit/protocol` and `zod`.

It must remain runtime-neutral and must not import NanoCore services, filesystem code, Web UI code, or client transport helpers.

## Agent Catalog Slice

NanoCore exposes:

- `GET /api/app/agents`
- `GET /api/app/agents/:agentId`
- `POST /api/app/workspaces/:workspaceId/agents/health/refresh`

The list and detail routes return product-visible agent catalog entries without adapter-native runtime config.

The client exposes `client.agents.list()`, `client.agents.get(agentId)`, and `client.agents.refreshHealth(workspaceId)`.

Stable agent catalog records continue to come from `@openkit/protocol`.

App API wrappers add only NanoCore-local read-model behavior.

## Action Center Slice

NanoCore exposes:

- `GET /api/app/workspaces/:workspaceId/action-center`

This route is the unified Human Attention read model for pending human actions, review states, recovery prompts, and app-local attention sources.

Approval mutations stay on the Core command path at `POST /api/approvals/:approvalRequestId/respond`.

Question response mutations stay on the Core turn-input path at `POST /api/turns`.

Artifact review decisions stay on the App API command path at `POST /api/app/workspaces/:workspaceId/artifacts/:artifactId/review`.

The client exposes `client.actionCenter.listHumanAttention(workspaceId)`.

## Workspace Repository Slice

NanoCore exposes:

- `GET /api/app/workspaces/:workspaceId/repositories`
- `GET /api/app/workspaces/:workspaceId/repositories/diagnostics`
- `POST /api/app/workspaces/:workspaceId/repositories/default`
- `PUT /api/app/workspaces/:workspaceId/repositories/default`

This slice is a redacted App API projection for workspace repository resources.
It must not expose raw host paths or adapter-native runtime config through Web-facing payloads.

The client exposes `client.repositories.list(workspaceId)`, `client.repositories.diagnostics(workspaceId)`, and `client.repositories.setDefault(workspaceId, input)`.

## Workspace Synchronization And Goal Mode Slices

Workspace synchronization read models and Goal Mode workflow routes are App API projections over stable Core workspace, thread, turn, item, artifact, and human-attention semantics.

The client exposes these routes through `client.app` because they are workflow/product projections, not standalone Core protocol objects.

Workspace synchronization client methods include review listing, review retrieval, input snapshots, materialization records, change sets, staged reviews, apply-result listing, and apply-result retrieval.

Goal Mode client methods include summary retrieval, start, plan creation, plan approval, bounded step execution, steering, artifact review decision submission, and Goal Review decision submission.

The deterministic test supervise-step route remains outside the public product client surface.

## Internal Development Cleanup Policy

This is an internal-development breaking change.

Removed aliases and old NanoCore response shapes are not preserved.

Provider diagnostics now use the strict current object shape.

Runtime config, diagnostics, and OAuth fields that existed only for earlier placeholder responses are removed from the typed surface.

## Correctness Notes

Auth responses now use concrete schemas instead of `unknown`.

`getArtifact` returns the `GetArtifactResponseSchema` payload type.

Empty successful delete routes return `void` without parsing through `z.never`.

Turn SSE validation errors are delivered through the async iterator instead of a callback-only subscription path.

## Current Implementation Projection

The composed `@openkit/core-client` surface, shared `@openkit/app-api-schemas` package, NanoCore App API validation path, Web consumption path, and MCP facade all follow this boundary.

The boundary is guarded by package tests that keep App API schemas runtime-neutral and OpenAPI tests that prevent first-party clients from reversing direction and consuming the generated OpenAPI artifact as the source contract.

The remaining items named in Future Slices stay outside this spec until their owning specs land the matching routes, schemas, and client methods.

## Future Slices

Sustained Mode, Delegation, Vault, Policy, gateway audit streams, and canonical Knowledge Store injection records remain out of the client until their specs, NanoCore routes, and schemas land in the same slice.
