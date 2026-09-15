---
type: change-plan
status: implemented
---
# Configurable Push Approval

## Intent Epoch 1

Source: engineer request to implement [OpenKit #68](https://github.com/lingkaix/openkit/issues/68) on `fix/68-configurable-push-approval`, preserving human approval by default, auditing auto-allow, all Vault/target/protected-branch/import restrictions, CLI and Web flows, and documenting trusted Workspace dogfood. Open a PR against main closing #68; do not merge. User authorizes implementation and PR publication.

## Owners And Decisions

`docs/specs/20260704-git_write_workflow.md` owns host push and its approval modes; `20260703-policy_enforcement_mapping.md` owns decision/audit projection; `20260703-workspace_synchronization.md` delegates publication. Use deployment-owned per-Workspace action entries in existing server config, avoiding new storage, Workspace-imported policy authority, or client payloads. Reuse granted Approval and Item ownership with a direct policy allow, not a fabricated human response. Changes activate after restart and only affect new requests.

## Checkpoint

Implementation complete; preparing the authorized PR. Deployment-owned entries select a Workspace's `repo.push` mode, defaulting to human approval. Automatic requests issue an audited exact-target grant and receipt with no human attention. Existing CLI and Web contracts are preserved. Replays survive mode changes and incomplete receipts remain unusable. Self-review inspected the code and specification diff; independent PR approval remains pending. No registered `.codex/agents/` capabilities exist in this checkout.

## Verification

All checks used repository-pinned Node 24.18.0 after frozen-lockfile dependency installation. Initial schema regression failed on unrecognized `policy`; the protected-target regression failed on wildcard-only authorization before its correction. These failures reached their intended oracles.

- `pnpm --filter @openkit/config-schema test`: 191 passed.
- `pnpm --filter @openkit/config-schema typecheck`: passed; package build passed as a NanoCore dependency.
- `pnpm --filter @openkit/nanocore exec vitest run src/policy src/config/runtime-config.test.ts src/server.test.ts src/vault/vault-admin-routes.test.ts src/runtime/git-push-executor.test.ts src/runtime/git-push-policy.test.ts src/approval-routes.test.ts src/action-center.test.ts --maxWorkers=2`: 271 passed across 10 files. Tests inspect concrete decisions, audit linkage, receipts, Turn/attention state, current Vault restrictions, redaction canaries, imported authority, interrupted calls, and protected targets. Local Git fixtures and injected command runners do not claim a live GitHub push.
- `pnpm --filter @openkit/web exec vitest run src/screens/workspace/workspace.test.tsx --maxWorkers=1 -t 'approval|push'`: 8 passed, 129 outside the filter; existing pending/granted Repositories flow and attention surfaces remain usable.
- `pnpm --filter @openkit/nanocore build`: passed, including TypeScript checking.
- Biome on all 14 changed TypeScript files: passed. Spec lifecycle, documentation model and generated documentation index checks: passed.
- `pnpm run build:openkit` and `node --test tests/openkit-skill-interface.test.mjs`: bundle rebuilt; 41 tests passed. Byte comparison confirms the generated bundle changed only the operation summary. Biome reports one pre-existing unused `input` parameter warning at `skills/openkit-operations.mjs:2663`; no new warning was introduced.
- Bundled CLI `ops describe` for `repository.push-request-approval`, `approval.respond`, and `attention.list`: all returned `ok: true`.

## Finding And Disposition

The added protected-wildcard route regression reached the Git runner and returned `auth-failed` where the accepted protected-target contract requires `rejected-protected`. Existing `evaluateGitPushPolicy` used wildcard matching for protected allowed targets. Restored its owner's literal-target requirement within #68 acceptance; non-protected pattern matching is unchanged. Both the unit regression and the automatic-mode route regression now pass.

## Next Action

Publish the reviewed commits to `fix/68-configurable-push-approval` and open a PR against `main` closing #68. Expected observable: the PR contains this scope and exact validation evidence, with independent review and merge still pending. Do not merge or change a deployed instance's policy.
