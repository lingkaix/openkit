# Pi AI Usage Ledger Repair

Type: change-plan
Status: complete
Date: 2026-07-12

## Intent

Make the live pi-ai gateway path record each terminal provider usage observation exactly once with distinct input, output, cache-read, cache-write, and estimated USD quantities, then delete the isolated normalizer that no production path calls.

Preserve the public OpenAI-compatible response and error vocabulary, current provider routing, existing usage-ledger ownership, and current gateway diagnostics.

## Scope

- Add `usd` to the shared usage-unit contract and generated projections without adding a cost table or storage migration.
- Preserve raw pi-ai terminal usage behind the internal adapter boundary instead of reconstructing durable usage from public OpenAI-normalized payloads.
- Thread one optional usage observer through the existing pi-ai client and dispatcher paths for non-streaming and streaming calls.
- Extend the existing gateway usage parser and durable recorder to emit positive token-class rows and one positive estimated-USD row.
- Record partial terminal usage for provider error or aborted outcomes before normalized errors leave the adapter boundary.
- Remove duplicate success/error usage reconstruction, error-carried usage, and the production-unreachable `pi-ai-usage.ts` owner.
- Move the exact dependency pin and importability assertion into the live pi-ai client test owner.
- Align protocol JSON Schema, NanoCore OpenAPI, accepted usage specs, NanoCore documentation, and the parent maintainability record.

## Non-Goals

- Do not add a billing model, currency object, exchange-rate conversion, budget policy, cost table, cost service, or usage-normalizer module.
- Do not expose pi-ai types, fields, provider ids, errors, cache keys, prompts, tool arguments, or credentials through protocol, App API, MCP, public gateway responses, diagnostics, or durable records.
- Do not add provider fallback, cross-provider retry, request replay idempotency, or client-disconnect propagation in this slice.
- Do not change native OpenAI or Codex provider routing.
- Do not change the existing SQLite usage-record layout because generic unit and quantity columns already own the required representation.

## Related Context

- [Parent NanoCore Maintainability Recovery](202607111531450001-nanocore_maintainability_recovery.md)
- [Architecture](../core/architecture.md)
- [Work Model](../core/work-model.md)
- [Agent Capability](../core/agent-capability.md)
- [Metering](../core/metering.md)
- [Product Vision](../product-vision.md)
- [Pi AI Provider Gateway Adoption](../specs/20260703-pi_ai_provider_gateway_adoption.md)
- [Audit, Usage, and Evidence Records](../specs/20260703-audit_usage_evidence_records.md)
- [Capability Usage Gateway Foundation](../specs/20260704-capability_usage_gateway_foundation.md)
- [LLM Gateway Responses API](../specs/20260526-llm_gateway_responses_api.md)

## Current Evidence

- `apps/nanocore/src/llm/pi-ai-usage.ts` has no production caller and is imported only by its own test.
- The live pi-ai client currently converts raw terminal usage to public OpenAI usage before durable recording, which drops cache-write quantities and `cost.total`.
- The public recorder then reparses the projected payload and has separate success and error paths, creating avoidable double-recording risk.
- `usage_records` already stores arbitrary text units with numeric quantities, so estimated USD needs one protocol enum value and no database migration.

## Accepted Decisions

1. One provider dispatch may produce one terminal usage observation. Raw usage is delivered through an internal callback on success, provider error, or aborted terminal state before public normalization.
2. Public OpenAI usage remains unchanged. Raw cache-write and cost fields never enter the response, SSE stream, error envelope, or diagnostics payload.
3. Durable token rows use the existing `tokens` unit and sources `input`, `output`, `cache_read`, and `cache_write`; estimated cost uses the `usd` unit and `cost_estimate` source.
4. Only positive finite quantities are recorded. Cost is an estimate from the pinned pi-ai catalog and is never billing truth.
5. The existing capability usage ledger remains the single durable owner. No parallel normalizer, service, table, or repository layer is introduced.
6. The exact-pin assertion moves into the live pi-ai client test before the isolated file and test are deleted.

## Execution Plan

### Slice 1: Shared Usage Unit

- Add failing protocol and App API projection tests for `unit: "usd"`.
- Add the one enum value and refresh generated protocol schema.

### Slice 2: Raw Terminal Observation

- Add pi-ai client tests for successful, error, and aborted terminal usage observed exactly once.
- Add one optional callback to existing pi-ai call paths and invoke it before return or normalized throw.
- Keep public response and stream assertions free of raw cost, cache-write, and pi-ai vocabulary.

### Slice 3: Durable Ledger Integration

- Add parser and black-box tests for input, output, cache read, cache write, cost, non-finite values, and no duplicate rows.
- Reuse the existing dispatcher context callback and `recordPublicLlmGatewayUsage` owner.
- Remove response reparse and error-carried usage once the terminal callback owns recording.

### Slice 4: Dead-Island Deletion

- Move exact-pin and importability coverage into `pi-ai-client.test.ts`.
- Delete `pi-ai-usage.ts` and `pi-ai-usage.test.ts`.

### Slice 5: Projection and Documentation Closeout

- Regenerate protocol JSON Schema and NanoCore OpenAPI.
- Align the three accepted usage specs, NanoCore README, this record, and the parent maintainability checkpoint.

## Verification Plan

- Run protocol tests, conformance, typecheck, lint, build, and generated-schema drift checks.
- Run App API schema tests, typecheck, lint, and build.
- Run pi-ai client, gateway usage, provider dispatcher, LLM Gateway, and capability ledger tests.
- Run the complete NanoCore, Core Client, and MCP package suites and build gates.
- Run NanoCore OpenAPI generation, official-schema validation, and drift checks.
- Run `CI=true pnpm run check:repo` and `git diff --check`.

## Stop Rules

- Stop if terminal usage can be observed more than once for one provider dispatch or if failed/aborted consumed usage is lost.
- Stop if raw usage, pi-ai vocabulary, credentials, prompt content, tool arguments, or cache keys reach any public or durable payload.
- Stop if the pinned dependency no longer states cost in USD; do not infer a currency or convert values.
- Stop if provider retries bill attempts that are absent from terminal aggregate usage; disable the retry or obtain explicit attempt telemetry rather than estimating.
- Stop if the change requires a new table, service, normalizer file, billing abstraction, or route-local idempotency mechanism.

## Implementation Checkpoints

- Failing shared-contract coverage preceded the single `usd` usage-unit enum value, and App API projection coverage verified the shared contract.
- NanoCore regressions captured missing raw Pi observation, cache-write, estimated cost, durable five-row behavior, and the diagnostics ratio failure before implementation.
- The Pi client now reports one raw terminal usage observation on success, provider error, or abort; the dispatcher is the single diagnostics and external-observer owner; the Codex public-payload path remains unchanged; positive input, output, cache-read, cache-write, and estimated-USD rows use the existing ledger; and error-carried usage, public-response reparsing, the unreachable `pi-ai-usage.ts` module, and its duplicate test owner are gone.
- The post-TDD Ponytail review removed the single-use `PiAiGatewayProviderError` wrapper, inlined the moved exact-pin package read, and retained no new table, service, normalizer, storage migration, or billing abstraction. The implementation commit removed 70 net production lines while adding the terminal observer and complete accounting behavior.
- The NanoCore README, three accepted usage specs, and generated App API OpenAPI were aligned. Full verification then exposed unrelated stale `quick-chat` workspace enum projections; only the two deterministic protocol JSON Schema files changed, and regeneration became clean.

## Verification Evidence

- Focused Pi client, provider dispatcher, gateway usage, and public Gateway coverage passed: 4 files and 68 tests. This includes Pi non-stream success, successful stream, terminal provider error, terminal abort, Codex non-stream and stream regressions, diagnostics compatibility, exact durable quantities, and leak assertions for raw cost, cache-write, and prompt-cache keys.
- The complete NanoCore suite passed with 187 files passed, 1 skipped, 1,385 tests passed, and 7 skipped. NanoCore typecheck, lint over 472 files, and build passed.
- Protocol passed 5 files and 147 tests; App API schemas passed 1 file and 54 tests; Core Client passed 1 file and 22 tests; MCP passed 6 files and 140 tests. Typecheck, lint, and build passed for all four packages.
- Protocol JSON Schema regeneration has no drift. NanoCore OpenAPI generation, official-schema validation, and committed drift checks passed. `CI=true pnpm run check:repo` passed spec lifecycle validation, Biome over 740 files, and the models-dev catalog validation.
- Independent correctness and Ponytail review returned GO with no P0, P1, or P2 findings. The quota-gated real-provider L6 path was not rerun solely to manufacture a non-zero cost estimate; deterministic boundary and durable-ledger coverage owns this repair, while the existing opt-in runner remains available for a future real-provider validation.

## Expected Handoffs

1. Commit this plan before tests or behavior changes.
2. Commit shared-contract tests before the protocol enum.
3. Commit NanoCore failures before terminal observer and ledger repair.
4. Commit dead-island deletion after the live path and pin coverage pass.
5. Close this record after independent correctness and Ponytail reviews plus full verification.
