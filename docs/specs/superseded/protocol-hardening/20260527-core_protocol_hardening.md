# Core Protocol Hardening

Status: Superseded
Implementation: N/A
Status Changed: 2026-06-28
Current Guidance: `docs/specs/20260628-protocol_contract_consolidation.md`
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

Protocol Contract Consolidation absorbed the hardening rules, schema requirements, compatibility removals, and conformance gates into one active protocol authority. The hardening campaign document lost authority because those requirements are now ordinary invariants of the consolidated contract.

## Retention Reason

This document preserves the original defect inventory, cleanup sequence, and strictness decisions so future protocol audits can trace why each invariant exists without treating a completed hardening campaign as current design ownership.
Date: 2026-05-27

Superseded note: The 20260529 cleanup spec extends hardening by removing protocol alias exports and rejecting missing `configVersion`, `output`, `itemType`, event `protocolVersion`, and API error `protocolVersion`.

## Summary

This spec records the breaking cleanup that narrows `@openkit/protocol` to the stable reusable Core protocol.

The goal is to keep Core solid before adding product modes such as sustained delegation, review mode, plan mode, or organize mode.

## Decisions

- Keep `Workspace -> Thread -> Turn -> Item[]` as the only core work backbone.
- Keep product modes as App/NanoCore routing semantics, not protocol enums.
- Keep sustained delegation, task ledgers, review requests, and thread goals out of protocol until dogfooding proves the stable shape.
- Require `requestId` on mutating command requests.
- Add required nullable request correlation to SSE envelopes.
- Add turn assignment fields that explain the selected agent, session, profile, and trigger source without runtime-native payloads.
- Add item lineage fields `parentItemId` and `causationId`.
- Add stable `status`, `plan`, and `memory-injection` item types.
- Replace generic item delta strings with `deltaKind`-specific payloads and validation.
- Add thin `CapabilityCall`, `UsageRecord`, and `AuditEvent` schemas for future attribution and governance.

## Protocol Boundary

`@openkit/protocol` owns stable Core records, command schemas, event envelopes, errors, item delta payloads, and conformance fixtures.

It does not own runtime config, Settings/Admin schema, diagnostics, provider config, OAuth, internal-agent diagnostics, dashboard read models, host paths, worker paths, launch commands, environment variables, or adapter-native payloads.

Runtime config and Settings schemas now live in `apps/nanocore/src/app-api/runtime-config.ts` and `packages/core-client/src/app-api/runtime-config.ts`.

`MaterializedWorkspaceRoot` is app/runtime-local. Protocol records may expose only sandbox summaries or workspace root references.

## Compatibility

This is an intentional breaking cleanup.

Removed `RuntimeConfig*` and `MaterializedWorkspaceRootSchema` exports are no longer part of `@openkit/protocol`.

Clients must send `requestId` on mutating commands.

NanoCore implements `requestId` as real command idempotency for the Core HTTP projection.

It persists a seven-day app-local ledger that stores only command name, request ID, non-secret scope IDs, canonical input hash, response resource kind and ID, creation timestamp, and expiry timestamp.

Duplicate requests replay the current resource snapshot for the original response resource, and mismatched duplicate input returns `409 idempotency_key_conflict`.

Clients must handle unknown live stream event names, item types, and item delta kinds through a generic fallback instead of crashing.

Strict protocol schemas remain the source of truth for conformance. The forward-compatible SSE parser exists only for live stream consumption.

The strict item type to item delta kind matrix must be encoded in the protocol schemas in a form that also appears in generated JSON Schema for non-TypeScript consumers.

The forward-compatible SSE parser may accept future additive item types or delta kinds, but known item delta payloads must still pass strict validation and must not fall through to the generic fallback.

## Migration

1. Update Core docs and App API docs to reflect the new ownership boundary.
2. Remove runtime config exports and generated runtime config JSON schemas from `packages/protocol`.
3. Move runtime config schemas to NanoCore and core-client App API modules.
4. Update NanoCore route validation, SSE event payloads, and app-local session/runtime types.
5. Update Web and core-client consumers to generate request IDs and render unknown protocol extensions safely.
6. Add thin thread update, thread archive, and artifact metadata update commands without promoting product modes into protocol.

## Test Gates

- Protocol tests cover removed exports, required request IDs, turn assignment, item lineage, new item types, delta payload validation, and thin capability, usage, and audit records.
- Protocol tests cover generated JSON Schema parity for valid and invalid item type to delta kind combinations.
- Core-client tests cover generated request IDs, App API runtime-config parsing, tolerant SSE parsing, and redaction guards.
- NanoCore tests cover route validation, command-correlated SSE envelopes, SSE replay, item deltas, runtime config App API parsing, and non-leaking agent session summaries.
- NanoCore tests cover app-local command idempotency, in-process duplicate collapse, conflict handling, ledger persistence, expired record pruning, and consistent `400 invalid_request` route validation.
- Web tests cover request ID generation through the client, unknown live stream fallback rendering, and removal of runtime config dependency from protocol exports.

## Deferred

- No `ThreadGoal`, `SustainedSpec`, `TaskLedger`, `DelegationRequest`, or `ReviewRequest` in protocol.
- No product mode enum in protocol.
- No shared `packages/app-api` package yet.
- No promotion of provider, OAuth, diagnostics, or dashboard read models into Core.

## 2026-05-28 Amendment

Memory deletion is part of the same mutating memory command family as memory creation and update.

NanoCore accepts `DELETE /api/workspaces/:workspaceId/memory/:memoryEntryId` with a required JSON body containing `requestId`.

The idempotency ledger records `memory.delete` with the workspace and memory-entry scope, but successful replay returns the same empty `204` command result because the deleted memory resource no longer has a current snapshot.

Core-client uses a status-aware fetch SSE transport for turn replay. The normative `204 No Content`, cursor, and opaque-close semantics are promoted to the Stream Cursor And Replay section of `docs/core/protocol.md`.
