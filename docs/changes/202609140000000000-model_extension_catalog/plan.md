---
type: change-plan
status: verified
---
# Model Extension Catalog

## Intent Epoch 1

Source: engineer request and https://github.com/lingkaix/openkit/issues/25. Implement a dedicated deployment-admin editable catalog for models missing from models.dev, with snapshot → extension → profile precedence, strict validation, existing runtime apply/restart behavior, generic editing, operator guidance and focused regressions. Preserve the Codex subscription 256K context cap and vendored bytes. Push one focused PR containing `Fixes #25`; do not deploy, merge, or include #16/#17.

## Owners And Accepted Decisions

The engineer explicitly authorizes the extension catalog contract. The Gateway metadata owner is `docs/specs/20260526-llm_gateway_responses_api.md`; file ownership and reload are owned by `docs/specs/20260628-nanocore_config_identity_contract.md`. Extend those owners with the requested behavior. Reuse strict Provider metadata fields, provider loading, generic config editing and existing restart-required Provider projection. No credentials, model admission bypass, custom form, watcher or transport is added.

## Checkpoint

Implemented `config/model-catalog.jsonc`, strict shared schema and editor/policy kinds, immutable template seeding, exact vendor/native-ID projection beneath profile metadata, complete catalog snapshot hashing and restart-required activation. The Gateway and adapter share effective metadata, including the Codex 256,000-token cap. Generic runtime-config endpoints preserve deployment-admin authorization, path containment and revision checks. The operator recipe documents registration, exact underscore/hyphen vendor spelling, precedence and apply/restart. Vendored snapshot files and authored Provider bytes remain unchanged by composition.

## Verification Evidence

- Entry regression: `pnpm --filter @openkit/nanocore exec vitest run src/config/model-catalog.test.ts` reached `provider.unknown_model_context` for the catalog-only model before implementation. The App API file-kind test also failed admission before adding the enum value. Initial missing-tool/dependency collection failures were setup evidence only; installation and workspace dependency builds enabled the actual regressions.
- Final focused command: `pnpm --filter @openkit/nanocore exec vitest run src/config/model-catalog.test.ts src/llm/logical-models.test.ts src/config/providers-loader.test.ts src/config/runtime-config.test.ts src/llm/pi-ai-client.test.ts src/runtime-config-files.test.ts src/runtime-config-reload.test.ts src/storage/fs-layout.test.ts` passed 175 tests across 8 files. The catalog file contributes 12 tests covering missing models, three-layer leaf precedence, exact scoping, zero pricing and computed adapter usage, both supported Codex vendor spellings, the 256K cap, immutable source bytes, file creation, malformed and stale writes, path escapes, last-known-good reload, strict and safe restart behavior, template preservation, and admin/non-admin HTTP access.
- `pnpm --filter @openkit/config-schema test` passed 190 tests. Config Schema and App API schema builds passed. NanoCore typecheck, lint and build passed; Core Client build and Web typecheck passed. Shared package lint passed with one pre-existing informational `useTemplate` diagnostic in `packages/config-schema/src/mcp-catalog.test.ts:326`.
- Full App API schema tests: 141 passed, 1 failed. The unrelated `keeps AgentSession identity out of ordinary embedded Turn projections` fixture omits `thread.entryPath`. A separate detached worktree at untouched base `b9b77bd` reproduced the identical failure (140 passed, 1 failed; no new catalog test there). Source and dependency contracts governing that fixture are unchanged. This is outside issue #25 and is retained as a PR disclosure, not corrected or skipped.
- `openapi:generate` and `openapi:validate` passed. The generated diff contains only the added file-kind values and source digest. Documentation-model and specification lifecycle validators passed. `git diff --check` passed. `git diff --name-only b9b77bd -- packages/models-dev-catalog` is empty.
- Direct review inspected source, final diff and named test output for precedence, Provider membership, active snapshot retention, adapter propagation, scope and authorization. No registered `.codex/agents/` capabilities exist in this checkout, so no agent delegation was used. Independent human approval of the PR remains a pre-merge gate; implementation verification does not satisfy it.

## Closeout Summary

Push the authorized branch and open one focused PR linking `Fixes #25`, with the baseline failure disclosed. Do not deploy or merge. All requested implementation and documentation predicates are covered; deployment activation requires the documented administrator-controlled restart. No #16 file-tree UX or #17 matrix work is included.
