# Protocol Package Organization

Status: Superseded

Superseded by: [Protocol Contract Consolidation](../../20260628-protocol_contract_consolidation.md)

Reference status: retained for detailed historical protocol and naming context after consolidation.

This spec records the intended organization for `packages/protocol`.

The stable protocol semantics live in `docs/core/protocol.md`, `docs/core/communication.md`, `docs/core/core-concepts.md`, and `docs/core/contract-evolution.md`. This document is an implementation plan for keeping the machine-readable package aligned with those core docs.

## Goals

- Keep protocol schemas reviewable and generated from one source.
- Avoid drift between TypeScript types, Zod schemas, JSON Schema, fixtures, and docs.
- Make protocol conformance testable by apps, Core implementations, and agent adapters.
- Keep app-only Settings, Admin API, diagnostics, provider config, OAuth, dashboard read models, and runtime-config schemas outside `packages/protocol`.

## Proposed Layout

```text
packages/protocol/
  src/
    ids.ts
    version.ts
    errors.ts
    records/
      workspace.ts
      thread.ts
      turn.ts
      item.ts
      artifact.ts
      approval.ts
      agent.ts
      agent-session.ts
      memory.ts
      identity.ts
      usage.ts
      audit.ts
    commands/
      discovery.ts
      workspace.ts
      thread.ts
      turn.ts
      approval.ts
      artifact.ts
      memory.ts
    events/
      envelope.ts
      workspace.ts
      thread.ts
      turn.ts
      item.ts
      agent-session.ts
      error.ts
    deltas/
      item-delta.ts
    fixtures/
      valid/
      invalid/
  schema/
    json/
```

Exact file names may change, but each durable record, command family, event family, error shape, and item delta family should have an obvious home.

## Authoring Rules

- TypeScript and Zod should be the authoring source for v0.0.1.
- JSON Schema should be generated from the package for non-TypeScript consumers.
- Durable records, command requests, command responses, event envelopes, and event payloads should be separate named schemas.
- Derived app read models belong in `docs/app-api.md`, `apps/nanocore`, and `@openkit/app-api-schemas`.
- Discriminated unions should use stable fields such as `type`, `kind`, `status`, or `event`.
- Extension namespaces should be explicit and optional.
- Protocol IDs should use the shared ID schema.
- Protocol timestamps should use the shared timestamp schema.
- Mutating command requests must require `requestId`.

## Conformance Fixtures

The package should publish fixtures for:

- valid IDs
- invalid IDs
- discovery response with `protocolVersion`
- event envelope with `protocolVersion` and `sequence`
- stream replay cursor examples
- item delta kind examples
- one valid and one invalid fixture for each item type to delta kind combination
- request delta correlation fixtures using `requestRefId`
- part delta correlation fixtures using `partId`
- stable API error codes
- duplicate command request ID handling metadata
- unknown optional extension preservation

Every fixture file should include the `protocolVersion` it targets.

Stream fixtures should include the stream kind and cursor scope.

## App API Boundary

`packages/protocol` is the stable Core package.

It should export workspace, thread, turn, item, artifact, approval, agent summary, agent session summary, knowledge, capability call, usage, audit, command, event envelope, error, and conformance schemas.

It should not export `RuntimeConfig*`, Settings/Admin API, diagnostics, provider config, OAuth, internal-agent diagnostics, dashboard read-model, or adapter-native launch schemas.

Runtime config, diagnostics, dashboard, OAuth, auth, automation, quick chat, search, turn feedback, Agent Catalog wrapper, and Action Center schemas live in `@openkit/app-api-schemas`.

`packages/core-client` imports those App API schemas but does not own or redefine them.

## MVP Scope

The current package only needs enough schema coverage to support `apps/nanocore`, `packages/core-client`, and `apps/web` while keeping the stable Core surface reusable.

The package should still reserve places for identity, vault references, usage records, audit events, and capability calls so later additions do not require restructuring the package.

## Related Docs

- `docs/core/core-concepts.md`
- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/contract-evolution.md`
- `docs/working_logs/2026-05-17-openkit-v0-0-1/prd-v0.0.1.md`
