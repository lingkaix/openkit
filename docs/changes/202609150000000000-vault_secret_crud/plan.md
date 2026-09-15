---
type: change-plan
status: implemented
---
# Vault Public Secret Management

## Intent Epoch 1

The engineer requested implementation of [#66](https://github.com/lingkaix/openkit/issues/66), public stdin-only CLI and password-input Web Admin secret create/rotate/revoke, workspace grants, the existing GitHub host-push binding, tests, documentation, and a PR to main closing the issue. No real PAT is required. Worker-side credential exposure and broader catalog UX are excluded.

## Owners And Method

`docs/core/vault.md`, `docs/specs/20260704-vault_backend_implementation.md`, `docs/specs/20260703-vault_secret_injection.md`, and `docs/specs/20260704-git_write_workflow.md` own material custody, reference/grant lifecycle, and approved host push. Implement their existing lifecycle through deployment-admin workspace operations, with fresh server-generated reference/grant ids and existing repository binding. The primary owns all changed paths. No registered `.codex/agents/` capabilities exist in this checkout.

## Checkpoint

Implemented five public workspace operations, typed client methods, stdin CLI catalog entries and regenerated executable, and password-input Web Admin CRUD. Existing filtered inventory, repository binding, host approval, encrypted backend, and Core cascades remain the owners. No real token or GitHub push was used. Source and final diff were inspected for scope, secret handling, simplicity, and ownership; independent merge acceptance remains outstanding because this checkout has no registered reviewer capability.

## Verification Evidence

All commands ran in this worktree through `mise exec --` with pinned Node 24.18.0 and pnpm 10.33.3. The initial schema regression failed on the missing export; after building missing workspace dependencies, the initial route regression failed with 404 on the missing handler. Neither the dependency setup failure nor test-fixture corrections are claimed as product failures.

- `pnpm --filter @openkit/nanocore exec vitest run src/vault/vault-admin-routes.test.ts src/openapi.test.ts src/runtime/git-push-executor.test.ts src/runtime/git-push-command.test.ts src/repository-routes.test.ts`: 83 passed.
- `pnpm --filter @openkit/nanocore exec vitest run src/auth/operation-authorizer.test.ts`: 26 passed.
- `pnpm --filter @openkit/core-client exec vitest run src/client.test.ts`: 79 passed.
- `pnpm --filter @openkit/app-api-schemas exec vitest run src/vault-secret.test.ts`: 1 passed.
- `pnpm --filter @openkit/web exec vitest run src/screens/settings/VaultSecretsPanel.test.tsx src/screens/settings/VaultAdminScreen.test.tsx src/screens/settings/settings.test.tsx`: 58 passed.
- `node --test tests/openkit-skill-interface.test.mjs`: 39 passed, no skips.
- Schema/client typechecks, NanoCore typecheck/build, Web typecheck/build, and `pnpm build:openkit`: passed. Web reports its existing large-chunk advisory.
- OpenAPI generation/validation, committed-artifact comparison test, documentation-model and spec-lifecycle validation, Agent-interface reachability, generated index check, and `git diff --check`: passed.
- Focused Biome check: passed with the pre-existing unused `input` warning in the server Vault-use catalog handler; no adjacent cleanup was added.

The L0-L2 assertions observe actual schemas, route responses, backend material resolution/revocation, Core records, typed transport, and Web query/mutation states. The host-push composition uses real local Git inspection, public enrollment/grant/repository/approval routes, and a substituted command runner that reports authentication failure while containing raw and encoded canaries. The runner receives the scoped credential, and response/history redaction assertions pass. This proves composition and redaction, not real GitHub authentication or publication. No new harness, deployment, runtime credential injection, or external effect domain was introduced.

## Delivery

Next action: commit the remaining implementation and documentation, push `fix/66-vault-secret-crud`, and open a PR to `main` with `Closes #66`. This publishes the reviewable code under the engineer's explicit authorization; it does not merge or satisfy the independent approval gate.
