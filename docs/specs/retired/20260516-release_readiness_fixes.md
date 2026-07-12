# Release Readiness Fixes

Status: Retired
Implementation: N/A
Status Changed: 2026-06-28
Current Guidance: None
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

This release-readiness work ended when the v0.0.1 fixes and cleanup decisions were completed. It is retired rather than superseded because it was a bounded release closure record, not a durable contract that a later specification needed to replace.

## Retention Reason

This document preserves the exact v0.0.1 agent-session visibility and wire-versioning release gates so maintainers can reconstruct the historical release decision and interpret the associated implementation changes.

Amendment 2026-05-29: The `ApiErrorSchema` default described below was later removed by [Remove Historical Compatibility Layers](../superseded/20260529-remove_legacy_compatibility.md). Current API error payloads must carry explicit `protocolVersion`, and validators reject missing versions.

## Summary

This spec records the final v0.0.1 release-readiness fixes for agent session visibility and wire protocol versioning.

## Goals

- Expose a real thread-bound agent session read model to the thread dashboard.
- Keep the web `AgentStatusBadge` bound to `AgentSessionStatus` values instead of derived turn states.
- Add `protocolVersion` to SSE event envelopes and API error records.
- Preserve forward-compatible parsing for newer minor protocol versions.
- Record v0.0.1 implementation naming gaps that need v0.0.2 cleanup.

## Non-goals

- Rename the v0.0.1 agent lifecycle records or event family.
- Rename `artifact-reference` items in v0.0.1.
- Add full Codex command output streaming polish in v0.0.1.

## Proposed design

`SseEventEnvelopeSchema` and `ApiErrorSchema` carry `protocolVersion` as a non-empty string with a default of the current `PROTOCOL_VERSION`. This keeps current emitters and fixtures explicit while allowing older clients to parse newer minor-version payloads for diagnostics.

Nano-core stamps SSE envelopes centrally when events are stored and returned. API errors are parsed through `ApiErrorSchema`, which materializes the version on every error response.

The thread dashboard returns `activeSession` as an agent session read model with `id`, `status`, and `message`. The host adapter returns materialized runtime sessions with UUIDv7 ids. The simulator returns deterministic `session_sim_<threadId>` ids and maps agent-session lifecycle records to `created`, `ready`, `busy`, `idle`, `failed`, or `closed`.

`POST /api/app/workspaces/:id/agents/health/refresh` keeps existing agent health rows and also returns refreshed session read models so the web badge can update from session state.

## Testing strategy

- Protocol conformance fixtures cover versioned event envelopes and API errors.
- Core-client tests cover the changed dashboard and health-refresh response shapes.
- Nano-core dashboard and health-refresh tests cover real session surfacing.
- Web component and app tests cover real session id rendering and enum status display.
- Release gates run package tests, typechecks, builds, e2e, coverage, and `pnpm verify`.

## Follow-ups

- v0.0.2 should align the v0.0.1 agent lifecycle event with the protocol-level agent session event design.
- v0.0.2 should align `artifact-reference` naming with the final artifact item protocol design.
- v0.0.2 should bridge real Codex `item/commandExecution/outputDelta` into rendered command output text.
