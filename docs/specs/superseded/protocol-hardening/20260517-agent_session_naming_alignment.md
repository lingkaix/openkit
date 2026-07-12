# Agent Session Naming Alignment

Status: Superseded
Implementation: N/A
Status Changed: 2026-06-28
Current Guidance: `docs/specs/20260628-protocol_contract_consolidation.md`
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

Protocol Contract Consolidation absorbed agent-session naming, identifiers, event fields, and compatibility rules into the active protocol owner. The naming-alignment slice lost authority because terminology changes must remain synchronized across schemas, events, clients, and core concepts.

## Retention Reason

This document preserves the original naming mismatch, migration reasoning, and affected protocol surfaces so future audits can understand the chosen vocabulary without reopening an independent naming contract.

## Summary

OpenKit v0.0.2 uses `AgentSessionSchema` as the canonical UI-to-Core wire shape for agent lifecycle visibility. The agent session update event family is `agent.session.updated`, and the event payload is `agentSession`.

## Goals / Non-goals

- Use the product-visible `AgentSessionSchema` everywhere the UI, core client, and nanocore stream agent lifecycle state.
- Remove the previous turn-scoped agent execution schema from the protocol package.
- Keep nanocore session storage thread-bound rather than turn-bound.
- Do not provide a transitional alias in v0.0.2.
- Do not change agent runtime private protocols or adapter-native item shapes.

## Background

The v0.0.1 implementation exposed a turn-scoped agent execution record even though the core model treats `AgentSession` as the durable product concept. The v0.0.2 PRD chooses a clean rename so protocol consumers see one canonical agent-session family.

## Proposed design

`packages/protocol` exports `AgentSessionSchema` from `models/agent.ts` as the wire shape. Server events use `AgentSessionUpdatedEventSchema` with `type: "agent-session-updated"` and `agentSession: AgentSessionSchema`.

`apps/nanocore` stores one session projection per thread. A first turn creates the session with `status: "created"`, `message: null`, and identical `createdAt` / `updatedAt` timestamps. Later lifecycle changes patch `status`, `message`, and `updatedAt`.

Runtime status mapping is:

| Previous runtime state | Agent session status |
| --- | --- |
| `queued` | `created` |
| `running` | `busy` |
| `waiting` | `suspended` |
| `completed` | `idle` |
| `failed` | `failed` |

## Alternatives considered

A transitional alias could accept both previous and canonical event families for one release. That was rejected for v0.0.2 because PRD decision 2C requires no automatic migration and no dual-write layer.

## Rollout / Migration plan

v0.0.2 performs a clean rename across protocol, nanocore, core-client fixtures, and web state. If alias support is ever introduced for an external support window, v0.0.3 is the removal milestone for that alias and its tests.

## Testing strategy

- Protocol schema tests cover the canonical event payload and reject the previous literal.
- nanocore snapshot and route tests cover persisted agent session projections and emitted stream envelopes.
- core-client and web fixtures advertise `agent.session.updated`.
- Generated JSON Schemas are regenerated from Zod.

## Risks & mitigations

Risk: Consumers pinned to the v0.0.1 event name will stop receiving agent lifecycle events. Mitigation: v0.0.2 is a clean protocol bump with no transitional alias by PRD decision.

## Open questions

None.
