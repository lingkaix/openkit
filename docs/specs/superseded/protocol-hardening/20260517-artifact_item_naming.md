# Artifact Item Naming

Status: Superseded
Implementation: N/A
Status Changed: 2026-06-28
Current Guidance: `docs/specs/20260628-protocol_contract_consolidation.md`
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

Protocol Contract Consolidation incorporated artifact-reference item naming and item-delta typing into the complete item and event contract. This naming slice no longer owns those semantics because artifact identifiers and delta behavior must evolve with the consolidated protocol model.

## Retention Reason

This document preserves the earlier artifact naming alternatives, migration constraints, and explicit-item-type rationale so maintainers can explain historical payloads without treating the isolated naming decision as current authority.

Superseded note: The 20260529 cleanup spec keeps `artifact-reference` as the canonical item type and now requires every item-delta payload, including artifact deltas, to carry explicit `itemType`.

## Summary

OpenKit v0.0.2 uses `artifact-reference` as the canonical item type for durable artifact pointers in the item log. The earlier artifact event naming is not part of the protocol, source fixtures, or generated schemas.

## Goals / Non-goals

- Keep `artifact-reference` as the single artifact item type across protocol, nanocore, core-client, and web.
- Validate artifact item deltas when `itemType` is supplied on an `item-delta` event.
- Keep artifact record event families (`artifact.created`, `artifact.updated`) unchanged because they describe materialized artifact records, not item type names.
- Do not introduce a transitional alias in v0.0.2.

## Design

`packages/protocol/src/models/item.ts` keeps `ArtifactReferenceItemSchema` with `type: "artifact-reference"`.

`ItemDeltaEventSchema` rejects explicitly tagged artifact-reference deltas unless the delta kind is one of:

| Item type | Allowed delta kinds |
| --- | --- |
| `artifact-reference` | `artifact-updated`, `snapshot-updated` |

Every `item-delta` event must carry `itemType`, and `validateItemDelta(event, item)` applies the same item-type validation when an item snapshot is available.

## Rollout / Migration

v0.0.2 is a clean naming alignment. Consumers should render artifact item records from `artifact-reference` and should not expect an artifact item alias. No automatic migration is required because the v0.0.2 data-root decision is fresh-root only.

## Testing Strategy

- Protocol tests accept `artifact-reference` plus `artifact-updated`.
- Protocol tests reject `artifact-reference` plus `text-delta` at the event schema and `validateItemDelta` helper layers.
- Nano-core simulator tests assert artifact update deltas include `itemType: "artifact-reference"`.
- Web Playwright e2e keeps the existing artifact flow as the browser release gate.
