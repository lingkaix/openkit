---
type: change-plan
status: implemented
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

## Primary Integration Checkpoint

The complete helper source08c4da20513206d549f2a12505fe57a168c2f9e2 was merged with git merge into lane/ga-vault-integration, then joined with the reviewed Server MCP dependency and current main. Additive guide conflicts retained both complete owner paragraphs. The separate custody correctionab0680b430532094123c300fc3b07145106b9a21 was also merged normally; four real probes had proved that an existing Workspace grant restriction draft survived in mutation cache despite zero transport. Existing schema validation now runs before capture and eleven old-panel regressions pass. No new custody mechanism or grant API is introduced.

Generated CLI and OpenAPI publish all three request/review/issue operations and both restricted Server delivery metadata reads. The exact Web contract now accounts for263total operations,75Server and186ordinary, with all three supported Vault workflow rows backed by real screens. The explicit Skill authority inventory includes the two Server metadata operations. p22-request-integrated-joined.log passed all88root Skill/Web inventory assertions,25native request cases,11Workspace custody cases and NanoCore/Web typechecks. The old joined87of88root failure was stale bundled CLI and is preserved as a failure; regeneration resolved it. These checks are focused integration evidence, not whole-module acceptance.

Independent review, exact committed-head express local-gate with whole affected-module suites and mandatory Web e2e, and the containing post-landing main-push CI remain required. No branch fullCI is dispatched under the engineer-approved12:55Z Express protocol. Equal membership and bounded preview are separate increments; when the former is integrated its member Policy accessor replaces the one current role accessor without changing the separate technical-administrator Vault gate.

## Independent Review Corrections

Independent review44d4603f requested four new descriptive response wrappers discard inert additions and two opaque allocation sites stop adding grant_/pd_ prefixes. Those corrections preserve strict command/terms/intent and known core validation. The focused schema regression proves unknown display additions are dropped, unsupported workflow states and authority terms fail, and raw-secret-shaped metadata remains refused. Full AppAPI26files276cases passed in p22-request-review-corrections.log.

Primary inspection then found a current public-path gap: request terms inherited the Workspace issuer's vault_ reference pattern, while published Server secret-create returns an opaque UUID. A read-only built-schema probe rejected that otherwise valid Server reference with invalid_format at referenceId. Terms now accept the existing opaque identity and still resolve exact canonical scope/backend authority. Native preparation now uses real public secret-create for both supported scopes, replacing direct prefixed seeding. The first integrated rerun passed five cases and failed twenty Workspace fixtures because the new common helper sent requestId to a Workspace operation whose strict body excludes it. The Workspace admission guard refused that invalid fixture before its subject; it is not delivery evidence. Match each published input instead of changing its contract.

p22-request-public-create-green.log then passed all25native request cases, NanoCore/Web typechecks, regenerated CLI/OpenAPI and all88root Skill/public-operation tests. The public Server create->request->review->issue->Gateway path now uses its actual opaque reference. These are local controlled effects only. Full UUIDv7 allocation remains the P14 shared-API join; no second generator or migration is introduced. Exact corrected-head review and whole-module express gate/Webe2e remain required.

## Main Integration And Express Gate

Merged main0f0673ba after independent APPROVEDe56bc629. Three additive conflicts retain both Shared MCP and Server operations route exports and both complete Web owner sections; Server audit current-account cache rules remain intact. Removed the unused fixture import noted in review. Regenerate the CLI and OpenAPI, then inspect and independently review the edited join. The exact committed-head Express gate must run all changed-module suites and Web e2e before acquiring the window. Branch full CI is not dispatched under the engineer-approved Express protocol.

## Equal-Member Integration

The primary integration branch merges the independently approved equal-member helper headbb485e1f with git merge. The issuer now consumes the existing evaluateWorkspaceMemberAccess adapter and labels its decision workspace-member-baseline:v1. Current issuing and deciding technical-administrator credential checks, actual actor/Approval linkage and one-claim issuance remain unchanged. Additive guide conflicts retain both complete feature procedures. Generated CLI/OpenAPI are temporary selected merge inputs until regeneration after the preview join; they are not accepted output yet. Before preview, the retired access-change operation reduces the integrated catalog to262total/75Server/185ordinary plus2Gateway operations. Final projection counts must be derived and checked again after all joins.

Merged the independently approved complete preview head08c20649 normally after the equal-member join. Native source merged without conflict; seven guide/manual/owner/inventory conflicts retain both complete supported journeys, one shared configuration paragraph and correct separate membership controls. Final expected operation inventory is263total/76Server/185ordinary plus2Gateway, pending actual generated-table proof. Existing request/preview/Server exact gate checkouts remain frozen; this separate checkout prepares the remaining integration without changing their bytes. Regenerate both generated merge inputs, inspect the actual cross-feature source and run focused integrations before exact independent review and a whole-module Express gate.

The existing public Workspace/Server issue regression now also checks the persisted current member-baseline label on the exact linked PermissionDecision. The member Policy association has its separate existing unit oracle; no trace or snapshot store is added. The Web owner count projections now consistently name the derived263/76/185 set, including the old147/195/46 textual projection that had become stale; inclusion semantics and all dispositions remain unchanged. These focused integration checks have not run yet.

## Joined Review Corrections

The combined focused pipeline passed all277 App API cases,84 native cases across seven P22 suites,52 Web cases,89 root inventory assertions, CLI/OpenAPI generation and validation, and documentation checks. The actual definition-derived inventory is263total/76Server/185ordinary plus2Gateway operations. These are focused results, not a full-module Express gate or browser execution.

Independent source review found that the preceding member-adapter integration gave a nonmember administrator inaccurate membership-derived Policy provenance. Current administrator eligibility permits this effect without creating membership. Both actual public nonmember issue cases reproduced the wrong engine/snapshot/reason after successful issuance;24 other cases were unselected. The issuer now records the already-established administrator verdict through the existing product decision recorder, with current-administrator and reviewed-intent labels. Every current issuer, actual decider, requester, Workspace, exact intent, claim, grant and Audit check remains. The regression asserts absent membership and one exact linked grant, Approval, PermissionDecision and actual-human Audit for each supported scope. The complete26-case request rerun, typecheck and formatting are queued; no green result is claimed yet. This correction supersedes the preceding proposed member-baseline label assertion and narrative.

Independent review also found that exact disclosure excluded nonmember current-administrator Web sessions through an older bearer-only helper. This is a required direct consumer for both the supported Vault workflow and the new Server shared captured-approval feature. A separate isolated helper owns the minimal existing public Workspace-authorizer correction, current/revoked/ordinary session regressions and actual captured shared-tool delivery/Audit proof. Its branch must be merged normally and independently reviewed. Frozen older candidate gates must finish unchanged, but cannot clear this known source defect.

The joined equal-member Web consumer retained Remove/Transfer dialogs when the same user row appeared after a selected-Workspace change. Both actual cached-target regressions failed at the retained real dialog;83 other account cases were unselected. The row now belongs to Workspace and user identity, which closes its old confirmation. The complete85-case account rerun and Web typecheck/formatting are queued. No new confirmation or authority mechanism is introduced.

The prior frozen request full-module run has reported a runtime-to-NanoHost fixture comparison failure and is still running; its final assertion details and disposition remain open. No fixture is changed or waived. The joined source remains a working branch until these corrections, normal preview/current-main joins, exact independent review and full Express gate including NanoCore and Web e2e pass. Latest main8cf3158d has a documentation-only operations-plan update and its main-push38917909017 passed. No P14 shared identifier API has landed at this observation.

The normally merged preview870 declaration is now present. Main8cf3158d is also merged. Correction to the preceding last-commit description: its complete range from0f0673ba includes the landed P29 update batch, not only the final operations-plan paragraph. The merge retained both complete English operator and MCP/Vault procedures. Only the generated CLI conflicted; its freshly generated P22 side was temporarily selected and must be regenerated and validated on the final joined source before exact independent review. The lane-owned delta against current main includes no CI or release script changes. The P29 main-push38917909017 passed; no inherited main change is claimed as this lane's feature or live proof.

The provenance correction completed its full26-case native request suite, Native typecheck and focused Biome with exit0. The ordinary Workspace-switch confirmation correction passed all85 account cases; the opaque-ID collision regression then failed both real Remove/Transfer dialogs before the injective JSON pair key correction. The final complete account rerun passed all87 cases, Web typecheck and focused Biome. Neither focused proof replaces the exact whole-module gate. The independent session correction remains in its isolated helper branch pending final GREEN and normal merge.

An independent method check reframed the earlier blanket promise to finish every later obsolete gate: the receipt-time instruction did not govern all future checks, and the three later candidates were independently proved unlandable. Only their exact verified isolated process groups were interrupted, with preserved LOCAL-GATE FAIL rc130 and all prior partial/failure evidence. The real runtime-to-Host fixture mismatch remains open and was reproduced by the unchanged isolated assertion with detailed default-reporter output. No fixture or acceptance check is weakened. The corrected joined head must execute every required module and browser suite again.

## Intent Revision 2

Source: coordinator approval under the engineer's 2026-10-16 16:15Z simplicity ruling. The200-file joined candidate is preserved as source and focused evidence, but will not land as one increment. Server shared MCP/Web lands first with required explicit catalog scope and the existing nonmember administrator-session disclosure correction, after P14. Bounded preview, equal membership and this full request/review workflow then land as separate coherent features near60files each. No pre-v0.1 catalog conversion or legacy reader is retained. This plan does not authorize importing the whole joined branch into an earlier feature.

The existing Host producer pin failed because the accepted two Worker Vault tools change one serialized MCP supply payload. Independent decoded-byte inspection found only those two tools, their catalog digest and derived length/checksum changes in one of24effects. The documented producer regeneration passed its selected case; complete structural reconstruction confirms no other fixture change. With updates disabled, both actual producer and dispatcher pins passed, and Native build passed. The following Rust command failed setup because it ran from the repository root despite an app-local Rust pin; zero Rust tests ran and no overall pipeline GREEN is claimed. The later full-request cut must use the NanoHost-owned working directory and complete its consumer/module checks. The fixture update adds no runtime behavior, normalization, compatibility or proof record.
