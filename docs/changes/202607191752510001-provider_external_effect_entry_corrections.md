# Provider And External-Effect Entry Corrections

Type: change-plan
Status: complete
Date: 2026-07-19

## Intent

Close WP-5A with the smallest provider and external-effect corrections required before real dogfooding supplies G07 evidence. This plan owns execution evidence only; C07, C19, S40-S43, S50 and their current release-coupled schemas remain the design authorities.

## Program Position

This is WP-5A of the [OpenKit Execution Program](./202607172152230001-openkit_execution_program.md). WP-5, the G07 docs-only authority correction, and this bounded package have exited. WP-6 production work remains gated only by one retained real completed work history.

## Frozen Scope

- Correct S41/S42 ownership and implementation projections so S42 is the sole non-Codex pi-ai backend owner while S41 retains only still-unique adopted-provider contracts.
- Align S40-S42 cache vocabulary and attribution around what NanoCore can prove: public Gateway Workspace attribution remains optional, governed internal-role calls require server-trusted Workspace and caller lineage, `cache scope` names the adapter input, and only provider-reported cache-read or cache-write usage is cache-effectiveness evidence.
- Reject a repeated CapabilityCall request id when its existing call record carries contradictory effect attribution; do not issue another upstream effect and do not add a recovery owner.
- Make uncertain Git push retry fail closed through the existing pre-effect guard and `recovery_required` boundary; do not infer remote success, repeat the push, or add reconciliation.
- Delete provider `extraHeaders` and `extraBody` fields because no current runtime consumer owns them.
- Tighten the existing real-provider runner only enough to use distinct request identities and prove health, non-empty text, cache behavior, leakage absence, and one configured non-custom provider whose public diagnostics dispatch family is `provider-api`; S42 remains the authority that this non-Codex family uses pi-ai internally.

## Excluded Work

- Native Responses fidelity, content-index and thinking projection, StopReason expansion, cancellation partial usage, provider cost authority, or a new provider backend.
- Codex browser/device OAuth login, refresh, cancellation, logout, account recovery, or credential bootstrap recovery.
- S45 license declaration or snapshot maintenance.
- Git reconciliation, remote-state inspection, settlement, background retry, or a new effect workflow.
- A new provider runner, acceptance harness, fixture platform, compatibility alias, or generic external-effect abstraction.

## Authority And Bounded Fallback

- S42 owns non-Codex pi-ai routing; S40 owns the public Responses contract; S43 owns the existing CapabilityCall/Usage evidence boundary; C19 owns metering truth; S50 owns Git push records and approval-gated execution.
- The existing command ledger remains replay authority only when its completed receipt exists. Contradictory attribution before an external effect fails closed. An effect that may have occurred without complete local proof returns `recovery_required`; the operator inspects existing owner state and issues a fresh authorized request only when safe.
- The fallback is intentionally incomplete but truthful. It does not promise exact recovery across provider or Git network effects.

## Test-First Execution

1. Correct S41/S42 provider ownership and cache/attribution vocabulary, S43 contradictory CapabilityCall attribution, and S50 uncertain Git-effect retry before changing tests, schemas, or production behavior.
2. Land the smallest focused tests for contradictory CapabilityCall attribution, uncertain Git push retry, deleted provider fields, and corrected real-provider request identity.
3. Implement by reusing the current CapabilityCall record, Git pre-effect guard, provider registry/dispatcher, and real-provider runner; delete unused fields and parallel ownership.
4. Run focused provider, capability, Git, schema and runner tests, then affected-package and repository gates once.
5. Perform a deletion-first review, record one checkpoint of at most ten lines here, and mark WP-5A complete only when every exit predicate below passes.

## Exit Predicates

- One non-Codex provider owner and one coherent cache-scope, effectiveness-evidence, and attribution vocabulary remain; no unimplemented cache-fidelity record is required.
- Contradictory CapabilityCall attribution cannot issue a second upstream effect.
- Uncertain Git push retry returns `recovery_required` without a repeated push or recovery workflow.
- `extraHeaders` and `extraBody` have no current schema, runtime, generated-contract, CLI, or authoritative/user-facing documentation residue; superseded specifications and this execution record may retain their names as non-authorizing history.
- The existing real-provider story passes the bounded health, text, cache, leakage and configured non-Codex `pi-ai` provider assertions without a new runner.
- Focused suites, affected-package checks, `CI=true pnpm run check:repo`, and `git diff --check` pass.

## 2026-07-19 Exit Checkpoint

- Result: S42 is the sole non-Codex provider backend owner; public diagnostics prove only the product-neutral `provider-api` dispatch family, and cache evidence uses provider-reported read and write quantities without inferred fidelity.
- Safety: contradictory CapabilityCall attribution rejects a second upstream effect, and uncertain Git-push replay returns `recovery_required` without remote inference, settlement, or retry machinery.
- Compromise: stock pi-ai receives the fixed non-secret `openkit-keyless` placeholder only for an explicitly keyless configured provider; the value has no authority, is never persisted or exposed as evidence, and hosted profiles still fail closed without credentials.
- Real proof: the existing runner passed on disposable A1 with stock Ollama `0.20.2`, `local-ollama`, and `qwen2.5:0.5b`, proving health, two distinct successful calls, non-empty text, reported zero cache quantities, Usage records, and an empty leak scan.
- Evidence: result SHA-256 `5394480e7d09a3f0e58b57c6d7bda1d32d3126af4ee3be1925223725a5314ce3`; leak-scan SHA-256 `1b881893ec4071e96d5a31209b9ed897c484bab967df50c99b54b323538e1236`.
- Verification: NanoCore passed 219 files with one skipped and 2,255 tests with three skipped; affected App API, Web, schema, typecheck, build, generated-contract, repository, and whitespace gates passed.
- Minimality: no provider fork or patch, new transport, durable record, recovery workflow, runner, harness, compatibility alias, or cross-domain atomicity entered the package; WP-6 retains only its separate real completed-history gate.

## Canonical References

- `docs/core/foundation.md`
- `docs/core/architecture.md`
- `docs/core/protocol.md`
- `docs/core/metering.md`
- `docs/product-vision.md`
- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`
- `docs/specs/20260708-pi_ai_unified_llm_backend.md`
- `docs/specs/20260704-capability_usage_gateway_foundation.md`
- `docs/specs/20260704-git_write_workflow.md`
