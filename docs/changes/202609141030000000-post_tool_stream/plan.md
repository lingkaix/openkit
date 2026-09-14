---
type: change-plan
status: implemented
started: 2026-09-14
branch: fix/issue-33-post-tool-stream
---
# Post-tool Responses Continuity

## Intent Epoch 1

Source: the engineer's request and https://github.com/lingkaix/openkit/issues/33. Diagnose and fix stream closure after successful worker tool execution, surface a safe useful cause, add focused regressions, push this branch and open one PR with `Fixes #33`. Do not deploy to A2; exclude Harness startup and adjacent refactoring.

## Owners And Method

`docs/specs/20260708-pi_ai_unified_llm_backend.md` owns native message/history preservation and stable redacted provider errors. `docs/specs/20260526-llm_gateway_responses_api.md` and `docs/specs/20260531-worker_turn_reliability_envelope.md` own terminal stream errors and worker failure projection. Restore those contracts through existing adapter and terminal owners without adding lifecycle state or transport.

## Result And Evidence

The stock pi-ai native parser preserves assistant message IDs and phases in its v1 text signature, but NanoCore discarded that carrier and emitted `message_0` without `commentary`. A regression replaying worker-visible output after a successful function result demonstrated exactly that corruption in the next provider request. Native text projection now restores the message ID and optional phase consistently in item/content frames, completed output and non-streaming output. The pinned parser exposes the carrier at `text_end`, so native text waits until that event; chat-provider text retains incremental delivery.

Gateway post-start errors previously emitted untyped data plus `[DONE]`. Pinned Codex 0.153.4's Responses parser recognizes `response.failed`, whereas those untyped errors leave it waiting for completion. Responses failures now carry that event type and the existing fixed redacted error. Worker closeout also reads the existing capability ledger and appends a fixed stream-failure detail only when the latest call for its exact Workspace, Thread, Turn, AgentSession and package has a known stream error. Earlier failures followed by success, other packages and unknown error text do not contribute a diagnostic.

Verification used Node 24.18.0 and pnpm 10.33.3. The stock-parser replay regression failed with `msg_before_tool`/`commentary` replaced by `message_0`; the framing regression failed because no `response.failed` existed; the worker diagnostic regression failed with only the opaque terminal message. Early fixture configuration/ledger setup failures were corrected before obtaining those deciding regressions. Gateway/client/worker-inference tests passed 162/162; the final worker-governance suite passed 111/111. NanoCore typecheck, lint and build passed, as did documentation-model and test-governance validation and diff whitespace checks.

An isolated local Codex 0.153.4 process using deterministic stock-parser provider responses executed `exec_command`, wrote and read back `proof.txt` containing exactly `openkit-tool-smoke-ok`, supplied its result to a second inference request, produced the final assistant verification and emitted `turn.completed` with process exit 0. Its `gpt-6` metadata warning remained present. This proves native client/tool/relay completion under the fixture and shows that the warning alone does not force failure; it is not live-provider or Task API acceptance. The probe initially lacked the production adapter's disabled web-search configuration and failed admission; with the actual adapter flags it passed without broadening tool admission.

The full NanoCore suite produced 2,899 passes and 25 failures. Twenty-four failures were missing container inputs in this sparse worktree; after adding the tracked `containers` paths, all 27 tests in the three affected container suites passed. The remaining `src/agents/catalog-routes.test.ts` failure expects HTTP 403 but receives 200 for a server-admin catalog read. It reproduces independently with all three changed production files temporarily restored to baseline `53b50c2`; candidate bytes were restored afterward. That unrelated baseline failure remains outside #33 and is not weakened or fixed here.

Named local evidence is retained uncommitted under `temp/issue33/`: `replay-red.log`, `worker-diagnostic-red.log`, `framing-red-and-fixture-setup.log`, `replay-green.log`, `worker-green.log`, `native-smoke.log`, `typecheck.log`, `build.log`, `all-tests.log`, `suite-failures.log` and `baseline-catalog.log`. The local probe is `temp/issue33-native-probe.mts`. External pinned parser source reads remain uncommitted under `temp/research/`.

## Closeout Boundary

The actual diff and named execution outputs were inspected for replay consistency, cancellation, redaction, exact worker lineage and unchanged terminal authority. This change adds no durable state or provider transport. The focused candidate is ready for one PR; independent PR approval remains a merge gate. A2 was neither accessed nor deployed. Its exact upstream rejection remains unobserved; the engineer explicitly selected this focused candidate without additional provider dumps.

## Intent Epoch 2

The engineer directed proceeding without more A2 provider dumps, explicitly selected native assistant identity/phase preservation plus Responses error framing, and reiterated commit, push, one PR with `Fixes #33`, and no A2 deployment. Local evidence remains distinct from an unobserved deployed provider failure.
