---
type: change-plan
status: implemented
date: 2026-10-20
---
# Internal Role Reasoning Effort

## Intent Revision 1

Source: the coordinator's implementation GO after accepting the Grok latency diagnosis. Add one optional `reasoningEffort` field to every internal-role execution profile using Protocol's existing enum. Omission preserves today's request. A selected profile supplies the internal Gateway request effort. Do not change Worker execution, credentials, endpoints, transport, or KM page-size guidance. No helpers or Claude-family agents. The coordinator reviews, lands, and sets the development profile.

Acceptance: begin with regressions for serialized LOW effort, unchanged omitted effort, and unchanged non-internal requests; run focused tests, typecheck, and Biome; then dispatch `.github/workflows/ci.yml` with `gate=l0-l2` on the exact candidate and verify its `head_sha` and all four NanoCore partitions. Append READY-TO-LAND with candidate SHA and run ID to the coordinator seam. This report does not satisfy the coordinator's reserved review or landing gate.

## Intent Revision 2

Source: the coordinator corrected the earlier failure comparison and selected the accepted Gateway contract as authority. Internal profiles must mirror Worker fitting through the same function, with no strict-refusal path or second policy. Add one focused internal/Worker unsupported-effort parity regression, then commit and push `fix/internal-role-reasoning-effort`, run exact-candidate `ci.yml` with `gate=l0-l2`, verify all four NanoCore partitions, and append READY-TO-LAND. Keep local runs focused because disk I/O is saturated by cleanup. Final review, landing and the development profile remain with the coordinator.

## Owners And Scope

- [Internal Agent Runtime](../../specs/20260813-internal_agent_runtime.md) owns internal-role profiles and shared execution.
- [Knowledge Manager Runtime](../../specs/20260704-knowledge_manager_internal_agent_runtime.md) owns KM use of the selected profile.
- [Gateway](../../specs/20260526-llm_gateway_responses_api.md#reasoning-effort-metadata-and-dispatch) and [AEP](../../specs/20260616-agent_environment_package.md) own existing Worker effort behavior.
- [Protocol](../../specs/20261021-protocol_identifiers_and_enums.md#canonical-enums) owns the reused effort values; no new enum or fallback owner is added.

The primary is the only writer. The cross-package seam is profile parsing and selection to the internal Gateway's native request, including ordinary and compaction calls. Tests must prove the selected profile reaches serialization, not merely that an isolated option is accepted. Four existing entry owners construct the Gateway provider; carry the selected profile value at each construction. The coordinator provides independent final review; no helpers are dispatched.

## Working Checkpoint

`origin/main` was fetched and merged as a fast-forward to `29e6c437dda8fc3e61a045bfcafd3fff046fa13a`; work continues on fresh branch `fix/internal-role-reasoning-effort`.

Resolved: internal profiles use the existing Worker fitting behavior in `dispatchLogicalModel`, which alone calls `fitGatewayEffort`. The internal caller supplies requested profile effort and serializes the attempt's effective effort; it neither copies the fitter nor changes Worker execution.

RED is established: profile tests failed on discarded valid efforts, accepted invalid efforts and missing JSON Schema declarations (9 failures, 4 passing unset cases); actual stock xAI request tests failed on the four missing LOW fields while four unset cases passed. Setup and fixture-capacity failures were corrected before counting RED. Supported/unset implementation now passes all 19 profile/deadline cases and all 90 Gateway provider cases; the new eight serialization/isolation cases also pass on pinned Node 24.18.0. Initial RED/green runs used the ambient Node 26.8.2; remaining deciding checks use the pinned Node runtime. Raw logs stay under `temp/changes/202610200624300000-internal_role_reasoning_effort/`.

The selected value is carried at five entry sites across Knowledge Manager, Assistant command and pending outcome, private administration, and Goal Coordinator. No extra profile or Worker field is introduced. The focused parity regression contacts the authenticated Worker route and internal provider with identical model supply: unsupported MEDIUM must become HIGH in both requests. RED observed Worker HIGH versus internal MEDIUM before the shared-dispatch correction.

Pinned Node 24.18.0 evidence: four config-schema files pass 23 tests; `gateway-provider.test.ts` and `profile-resolver.test.ts` pass 93 tests. `turbo run typecheck --filter=@openkit/config-schema --filter=@openkit/nanocore` passes all 13 selected dependency tasks. Biome checks all eight changed TypeScript files with no remaining fixes. Canonical NanoCore `openapi:generate` and `openapi:validate` succeed with no generated diff; the administration configuration schema is generated at runtime by the existing catalog. `validate-doc-model.mjs`, `validate-spec-lifecycle.mjs`, `generate-doc-index.mjs --check`, `validate-test-governance.mjs` and `git diff --check` all pass.

After the fitting correction, pinned Node 24.18.0 focused checks pass 123 tests: seven Worker effort/parity cases (103 unrelated cases excluded), 93 internal Gateway/profile cases, and 23 configuration cases. The parity test first failed at its intended assertion with internal MEDIUM versus Worker HIGH, then passed after the correction. The two scoped typecheck selections pass all 13 dependency tasks; Biome checks all nine changed TypeScript files. Logs: `fitting-red.log`, `fitting-green.log`, `gateway-final.log`, `config-final.log`, `typecheck-final.log` and `biome-final.log` under the existing temporary evidence directory.

A broader eleven-file NanoCore run before the coordinator's focused-only instruction reached the local 240-second process timeout without a terminal test summary; it is not counted as proof. Its raw log is retained as `nanocore-focused.log`. No full local suite is repeated. No landing, development-profile update, credential/endpoint/transport change or model probe is part of this change.

The first pushed candidate `96c6ff6273c9104a12fa74224b149ed892599474` ran CI `39382710761`. Its root shard found a missing derived CLI update: canonical rebuild changed `skills/openkit-ops/scripts/openkit`. That failure is not waived. Regenerated the bundle with pinned Node 24.18.0 and canonical `pnpm build:openkit`; the two focused CLI interface/redaction files pass all 94 tests. The superseded run was cancelled after its root failure was retained so the corrected candidate can use the branch's serialized CI group. No check or threshold was weakened.

Next action: publish the corrected candidate and dispatch `ci.yml` with `gate=l0-l2`. The final coordinator seam must cite the candidate SHA and successful run after verifying `head_sha`, the L0-L2 aggregate and all four NanoCore partitions. Record that immutable external evidence in the seam rather than changing the candidate after CI. Until that evidence exists, this record claims implementation and focused proof only, not READY-TO-LAND or independent acceptance. The coordinator retains final review and landing.
