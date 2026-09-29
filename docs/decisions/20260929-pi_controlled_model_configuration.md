---
status: Superseded
date: "2026-09-29"
decider: Engineer
superseded-by: docs/decisions/20260929-four_native_runtime_adapters.md
---
# Controlled Pi Model Configuration

## Decision

The engineer approved amending the Pi adapter specification to permit one controlled, ephemeral native models.json for a bounded Task through OpenKit's existing internal inference Gateway. Translated from the engineer's instruction: "Modify the specification document to allow this proposed change." The approved proposal keeps upstream subscription credentials server-side, references the existing distinct inference credential through an environment variable, preserves retained workspace/native files, and does not adopt RPC, MCP or native-session reuse. Behavioral rules live in the affected owners below; approval of the design does not prove implementation or release readiness.

## Reason

The pinned Pi CLI uses models.json for a custom inference endpoint. OpenKit's previous blanket prohibition prevented the already-owned Gateway route from being consumed by Pi. A descriptor generated solely from admitted inputs satisfies that current need without exposing an upstream Provider route or introducing a generic native-configuration mechanism. Independent Consultant scrutiny confirmed that a fresh bounded Turn can use the existing non-reusable Harness path without a new session-continuity implementation.

## Rejected Alternatives

- Keep the blanket generated-file prohibition: blocks the requested Pi/Grok Task despite a working server-side Grok subscription route.
- Give Pi the upstream subscription credential or use a direct Provider fallback: bypasses the existing inference authority and routing boundary.
- Load arbitrary retained or project native configuration: lets ungoverned settings influence current execution authority.
- Fork Pi or introduce RPC/session continuity for this repair: unnecessary for one bounded Task and exceeds the immediate mainline release goal.

## Revisit When

The pinned Pi runtime changes its supported custom-endpoint mechanism, or an independently accepted requirement needs native-session continuity or additional capabilities. Reconsider the implementation mechanism without silently broadening route or credential authority.

## Affected Owners

- docs/specs/20260716-pi_worker_adapter.md
- docs/specs/20260629-worker_runtime_communication_model.md
