---
type: change-plan
status: in-progress
date: "2026-10-16"
branch: lane/ga-request-review
---
# Supported Vault Grant Request And Review

## Intent Revision 1

Source: the L-GA independent P22 request/review assignment. Deliver request, exact review, grant issue, narrowing and revocation for the supported credential paths. Reuse existing Workspace grants, Pending Requests, Policy, injection records and explicit bindings. Preserve current responsible-user and administrator eligibility, exact initiating actor, per-effect authority and material isolation. No live credentials, host effects, future credential class, new store or generic runner is authorized. Whole-P22 and live-host acceptance remain outside this feature.

## Owners And Boundaries

[Vault](../../core/vault.md) owns use authority and evidence. [Permissions](../../core/permissions.md) owns current actor and Policy checks. [Vault Secret Injection](../../specs/20260703-vault_secret_injection.md#supported-grant-request-and-review) freezes the finite workflow projection before production changes. [Vault Backend](../../specs/20260704-vault_backend_implementation.md#public-workspace-secret-administration) limits the issuer shapes. [Pending Requests](../../specs/20260930-pending_requests.md) owns command intent, exact disclosure, review, claim, cancellation, restart and delivery.

The cross-owner seam is a captured non-secret command intent consumed once into the existing VaultGrant. Tests observe canonical request, grant, PermissionDecision and Audit facts, plus real API framing. Web uses the same definition-derived client. Existing sink tests distinguish backend resolution from injection completion. Primary review and integration remain separate from this producer report.

## Checkpoint

The assigned worktree and branch are exclusive write ownership. Unrestricted filesystem tools do not enforce this prompt-only boundary. No subhelper is authorized. Dependencies are isolated; builds and tests use Node 24.18.0, pnpm 10.33.3, the shared slot runner and one Vitest worker. The implementation now joins supported Workspace and Server shared-MCP request/review/issue to existing Pending Request, PermissionDecision, VaultGrant and Audit owners. Web controls include exact request review and Server material/grant operations with transient custody. Worker requests require exact verified AEP and current canonical MCP slot/scope/digest or an already declared Workspace reference. Server delivery evidence reads reuse existing plan/receipt owners. Raw evidence remains outside the repository under evidence/L-GA.

## Direct Consumer Paths

The direct out-of-area consumers are `apps/nanocore/src/operation-composition.ts`, `apps/nanocore/src/runtime/openkit-generative-mcp.ts`, `apps/nanocore/src/runtime/pending-request-flow.ts`, `apps/nanocore/src/worker-mcp-routes.ts`, the shared API schema declarations and exports, Web Vault screens/components, and affected local guides/manuals. The Worker relay only forwards its existing Vault owner. The built-in table adds request and state read, preserves trusted execution binding and the existing response ceiling, and admits no issuer. The Pending Request correction limits the exact-disclosure prerequisite to granting, preserving denial when preview is unavailable.

## Evidence Frontier

`request-review-core-second.log` and `request-review-core-third.log` each passed the first nine API regressions. `request-review-current.log` then exposed one implementation defect in trusted Worker lineage capture and three fixture errors. Exact captured lineage now selects its five owned fields. `request-review-core-final.log` passed NanoCore typecheck and six focused owner suites: 44 tests, including actual reviewed Workspace and Server Gateway sinks, Worker selection, exact-preview deny/withdraw, post-Core unknown settlement, Server evidence readback and session credential replacement. `request-review-web-complete.log` passed Web typecheck, four focused suites (32 tests), and production build. `request-review-authority-complete.log` passed NanoCore build, four focused suites (63 tests), and focused Biome checks. It includes runtime-env exact targets, archive, expiry and reference revocation. `request-review-web-lock-guard.log` passed Web typecheck and 18 backend-screen tests, including the competing shared-material write guard. `request-review-worker-readback-final.log` passed NanoCore typecheck and both later-session Worker readback cases (19.37s), preserving the closed original session and original issuance lineage. The first successor fixture correctly hit the one-open-attempt constraint; it now closes its never-submitted preparation through the existing no-effect API and reopens product state without live admission hooks. `request-review-web-custody-complete.log` passed Web typecheck, both new panel suites (11 tests, 9.24s), and focused Biome. Request and Server grant restriction forms validate through their existing schemas before mutation retention, clear rejected fields and emit fixed safe text. Canary regressions prove zero API or mutation-cache admission for unsafe fields.

Documentation-model and specification-lifecycle validation, generated documentation-index check, test governance and `git diff --check` passed. The initial dependency-collection failure and incorrect Thread status expectation prove no product behavior. No live credential, vendor, account, host, service or release effect occurred. Raw named logs and a full path list remain under evidence/L-GA outside the repository. Independent primary review, generated CLI/OpenAPI integration and whole-P22/live-host acceptance remain outside this producer report.

## Out-of-area Paths

The following explicit paths are outside `apps/nanocore/src/vault/` and are direct consumers, accepted owners, guides, focused regressions or this change record:

- `apps/nanocore/README.md`
- `apps/nanocore/src/operation-composition.ts`
- `apps/nanocore/src/runtime/README.md`
- `apps/nanocore/src/runtime/openkit-generative-mcp.ts`
- `apps/nanocore/src/runtime/pending-request-flow.ts`
- `apps/nanocore/src/worker-mcp-routes.ts`
- `apps/web/README.md`
- `apps/web/src/screens/settings/ServerVaultSecretsPanel.test.tsx`
- `apps/web/src/screens/settings/ServerVaultSecretsPanel.tsx`
- `apps/web/src/screens/settings/VaultAdminScreen.test.tsx`
- `apps/web/src/screens/settings/VaultAdminScreen.tsx`
- `apps/web/src/screens/settings/VaultGrantRequestsPanel.test.tsx`
- `apps/web/src/screens/settings/VaultGrantRequestsPanel.tsx`
- `apps/web/src/screens/settings/VaultScreen.tsx`
- `docs/changes/202610161240000000-vault_grant_request_review/plan.md`
- `docs/specs/20260628-web_product_surface_projection.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260704-vault_backend_implementation.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
- `packages/app-api-schemas/README.md`
- `packages/app-api-schemas/src/index.ts`
- `packages/app-api-schemas/src/vault-grant-requests.test.ts`
- `packages/app-api-schemas/src/vault-grant-requests.ts`
- `packages/app-api-schemas/src/vault-operations.ts`
- `packages/core-client/README.md`
- `skills/openkit-ops/references/nanocore-operations.en.md`
- `skills/openkit-ops/references/using-openkit.en.md`
