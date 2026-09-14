---
type: change-plan
status: active
started: 2026-09-14
branch: fix/issue-33-post-tool-stream
---
# Post-tool Responses Continuity

## Intent Epoch 1

Source: the engineer's request and https://github.com/lingkaix/openkit/issues/33. Diagnose and fix stream closure after successful worker tool execution, surface a safe useful cause, add focused regressions, push this branch and open one PR with `Fixes #33`. Do not deploy to A2; exclude Harness startup and adjacent refactoring.

## Owners And Method

`docs/specs/20260708-pi_ai_unified_llm_backend.md` owns native message/history preservation and stable redacted provider errors. `docs/specs/20260526-llm_gateway_responses_api.md` and `docs/specs/20260531-worker_turn_reliability_envelope.md` own terminal stream errors and worker failure projection. Restore those contracts through existing adapter and terminal owners without adding lifecycle state or transport.

## Checkpoint

The current projection drops native assistant message identity and phase before the worker replays history after a tool. The Gateway emits untyped error data, which pinned Codex 0.153.4's Responses parser does not recognize as a terminal error. Local stock-parser round trips will check exact native history and completion after a tool result; route tests will check a typed redacted terminal failure. These deterministic observations do not establish which upstream error A2 encountered. A2 is not accessed or deployed by this change.

## Next Action

Add and run regressions before implementation. Expected observations: native message identity/phase differ from provider output, and worker error SSE lacks `response.failed`. Preserve exact failure evidence before correcting the projection.

## Intent Epoch 2

The engineer directed proceeding without more A2 provider dumps, explicitly selected native assistant identity/phase preservation plus Responses error framing, and reiterated commit, push, one PR with `Fixes #33`, and no A2 deployment. Local evidence remains distinct from an unobserved deployed provider failure.
