# Protocol Lifecycle Enums

Status: Superseded

Superseded by: [Protocol Contract Consolidation](../../20260628-protocol_contract_consolidation.md)

Reference status: retained for detailed historical protocol and naming context after consolidation.

## Summary

US-002 adds named Zod enum exports for protocol lifecycle state families that were already documented in `docs/core/protocol.md`.

## Goals / Non-goals

- Export `TurnStatusSchema`, `ApprovalStatusSchema`, `ItemStatusSchema`, `AgentSessionStatusSchema`, and `ItemDeltaKindSchema` from `@openkit/protocol`.
- Reuse the named schemas in existing protocol models where those status fields already exist.
- Rename approval response decisions from `approved` and `rejected` to `granted` and `denied`.
- Do not add a `AgentSession` record schema yet.
- Do not wire `ItemDeltaKindSchema` into item delta payloads yet.

## Background

`docs/core/protocol.md` defines canonical lifecycle enum families for v0.0.1, but several values were still inline in Zod models or missing from `@openkit/protocol`.

## Proposed design

The protocol package owns each enum as a named Zod schema and inferred TypeScript type.

`TurnSchema.status`, `ApprovalRequestSchema.status`, and the shared item base status now reference the named enum schemas instead of repeating literals inline.

`AgentSessionStatusSchema` is exported from the agent model module as a standalone enum until the session record becomes part of the machine-readable package.

`ItemDeltaKindSchema` lives under `src/common` because item delta kinds are shared stream metadata, not a specific event payload shape in this iteration.

## Alternatives considered

Keeping inline enums would preserve the existing implementation but would not give UI developers stable imports or a single value source.

Wiring item delta kind into `ItemDeltaEventSchema` now would exceed US-002 because current item delta payloads still use the older string delta shape.

## Rollout / Migration plan

Approval decision callers must send `granted` or `denied` instead of `approved` or `rejected`.

Generated JSON Schema artifacts must be regenerated from the Zod source.

## Testing strategy

Vitest asserts the exact `.options` arrays for all five exported enum schemas.

Protocol, nanocore, core-client, and web typecheck/test commands validate the workspace after rebuilding `@openkit/protocol`.

## Risks & mitigations

Approval status rename is breaking for clients that still send `approved` or `rejected`.

The nanocore simulator and web approval flow were updated in the same iteration to keep local consumers aligned.

## Open questions

The future `AgentSession` record schema still needs its own story.
