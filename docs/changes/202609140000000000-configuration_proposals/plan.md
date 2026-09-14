---
status: verified
type: change-plan
---
# Configuration Proposals — Issue 24

## Intent Epoch 1

Source: engineer request and https://github.com/lingkaix/openkit/issues/24. Restore Server Operation Agent gateway/provider configuration proposals and authorized application, reproduce the unavailable path, push this branch and open one focused PR with `Fixes #24`. Do not deploy to A2 or absorb adjacent work.

## Owners And Method

The Administration Entry Path in `docs/specs/20260704-chat_mode_assistant.md` owns immutable Artifact candidates, private presentation, current administrator authorization and human-confirmed application. Runtime configuration remains with `docs/specs/20260628-nanocore_config_identity_contract.md` and existing config schemas, file validation/CAS and reload services. This slice updates existing gateway logical-model bindings and Provider catalog metadata; credential binding and service restart stay with their existing owners. No new proposal table, model-callable apply Tool or approval lifecycle is introduced.

## Closeout Summary

Implemented the bounded catalog adapter over existing Artifacts, their automatically created reference Items, command receipts, runtime configuration validation/CAS and safe reload. The six-Tool administration entry now discovers Provider/Gateway targets, exposes editable schemas and publishes exact private candidates. `administration.configuration-apply`, its typed client and public endpoint accept only payload-bound human confirmation; they recheck current administrator authority, private candidate identity, source revision and dependencies. Existing credentials and extensions are preserved. Reload failure is reported separately from persistence; interrupted writes are fenced by the existing status Item and require inspection. Provider changes remain subject to the existing restart requirement. No new table or model-callable apply operation was added.

## Verification Evidence

- The regression at commit `1aae5e4` failed at the old unconditional unavailable result: one failed, two passed in `configuration-tools.test.ts` before implementation.
- `pnpm --filter @openkit/nanocore exec vitest run src/config/administration-configuration.test.ts src/administration src/internal-agents/internal-agent-loop.test.ts src/internal-agents/gateway-provider.test.ts src/auth/operation-authorizer.test.ts src/openapi.test.ts src/config/runtime-config-routes.test.ts`: 10 files, 80 tests passed.
- An additional reopen/replay assertion exposed duplicate reference Items because `FsStore.createArtifact` already publishes its reference. Removing the duplicate publication restored real store reload; the final focused configuration suite passed all seven tests, including durable replay without another write.
- `pnpm --filter @openkit/app-api-schemas exec vitest run src/administration.test.ts`: three passed. `pnpm --filter @openkit/core-client exec vitest run src/administration.test.ts`: one passed. `node --test tests/openkit-skill-interface.test.mjs`: 21 passed.
- NanoCore typecheck/build, App API schemas build/typecheck, Core client build/typecheck, OpenAPI generation/validation, CLI bundle/reachability, documentation-model and test-governance checks passed. Changed-file Biome checks passed with the pre-existing unused `input` parameter warning on `listServerVaultUseRecords` in `skills/openkit-operations.mjs`; no warning was introduced by this change. `git diff --check` passed.
- Checks ran with Node 24.21.0 and pnpm 10.33.3; the environment warns because the repository pins Node 24.18.0. No repository toolchain or dependency declarations changed.
- Self-review inspected actual configuration, authorization, schema/client/CLI and generated API diffs. Independent human approval remains the PR merge gate; this checkout has no registered `.codex/agents/` capabilities. No production deployment, external provider request or A2 operation was performed.

## Checkpoint

The engineer authorized pushing this branch and opening one focused PR with `Fixes #24`. Publication is the remaining external step; the final response records the open PR URL. Target creation, credential/endpoint changes, service restart and broader management scope remain with their existing owners and are outside this catalog-update fix.
