---
type: change-plan
status: implemented
date: "2026-10-16"
branch: lane/ga-request-p14
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
- `apps/nanocore/openapi/app-api.openapi.json`
- `apps/nanocore/src/operation-composition.ts`
- `apps/nanocore/src/runtime/README.md`
- `apps/nanocore/src/runtime/openkit-generative-mcp.ts`
- `apps/nanocore/src/runtime/pending-request-flow.ts`
- `apps/nanocore/src/worker-mcp-routes.ts`
- `apps/nanohost/README.md`
- `apps/nanohost/src/core-effect-command-fixture.json`
- `apps/web/README.md`
- `apps/web/src/screens/settings/ServerVaultSecretsPanel.test.tsx`
- `apps/web/src/screens/settings/ServerVaultSecretsPanel.tsx`
- `apps/web/src/screens/settings/VaultAdminScreen.test.tsx`
- `apps/web/src/screens/settings/VaultAdminScreen.tsx`
- `apps/web/src/screens/settings/VaultGrantRequestsPanel.test.tsx`
- `apps/web/src/screens/settings/VaultGrantRequestsPanel.tsx`
- `apps/web/src/screens/settings/VaultScreen.tsx`
- `apps/web/src/screens/settings/VaultSecretsPanel.test.tsx`
- `apps/web/src/screens/settings/VaultSecretsPanel.tsx`
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
- `skills/openkit-ops/scripts/openkit`
- `tests/openkit-skill-interface.test.mjs`
- `tests/web-user-operation-surface-contract.test.mjs`

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

## Bounded Request Feature Preparation

The coordinator approved a separate full request/review increment under the engineer's simplicity rule. Start from preserved `2a5605ab24d0670061120e7d90aca291f7602bbd` and normally merge preview parent `211438d3b931652cc92255f0920613bce6177dd6`, which includes the current Server-first parent. The initial request delta is 38 paths against preview. Equal membership remains a later pending dependency; no joined 200-file branch or Equal adapter is imported. Normal additive owner/manual joins preserve complete Server, preview and request behavior. Actual generation resolves shared CLI/OpenAPI conflicts. Prior cancelled gates remain FAIL and no full/browser success is inferred.

The known issuer correction uses the existing product PermissionDecision writer to record `nanocore-vault-policy:v1`, `reviewed_vault_grant_issue` and `reviewed_vault_grant_administrator_authorized`. Existing current issuer, deciding credential, requester, Workspace, exact intent, claim and Audit checks remain unchanged. A nonmember administrator gains no fabricated owner/member role. The retained real public Workspace and Server tests check this provenance, actual actor and linked Approval/Audit. Prior deciding evidence is the two-scope failure and 26-case correction in the preserved branch; this branch requires its own focused rerun. No new design, lifecycle, recovery owner or test matrix is added.

P14 and final Server/preview/Equal parent choices precede final review and gate. Only useful focused request/type checks run during preparation. Host effect fixture updates wait for an actual producer failure against the final parent, and no host or broad suite runs now. Reviews block only for a reachable defect, a violation of an accepted owner contract, a security defect, or loss of user content. Every other finding is a non-blocking note. External checkpoint is `evidence/L-GA/request-next-checkpoint.md` in the backlog.

## Prepared Request Cut Verification

The normal preview-parent merge and minimal provenance correction passed the existing full 26-case request suite on this branch. Its two existing scope cases now use the fixture's actual nonmember administrator Web session for list, complete effect disclosure, review and issue. They assert the captured deciding session Token, truthful stored PermissionDecision, exact Approval/Audit links and absent fabricated membership. No separate disclosure fixture or matrix was imported. The source still checks both the current issuer and actual deciding credential; authenticated session identity alone grants nothing. The feature remains 38 paths against preview parent `211438d3b931652cc92255f0920613bce6177dd6`.

Pipeline 44676 completed with exit 0. Exact output is `evidence/L-GA/request-next-focused.log` in the backlog: 26 native cases, 89 root Skill/Web inventory cases, prerequisite builds, CLI/OpenAPI generation and validation, NanoCore/Web typechecks, focused Biome, documentation model (527 documents), lifecycle/index/test governance and whitespace passed. The earlier two-scope provenance failure remains separately preserved; this preparation does not claim a new pre-change RED or a full/browser gate. Normal merge output conflicts were resolved by generation. No Server/catalog/session/preview behavior, Equal adapter or host fixture was changed. Final parent selection, required host producer check if applicable, independent review and exact full gate remain open.

## R1 — Required Host Fixture Consumer

Independent review of `bd790f56766937dfbca1ec28733a59429cf413cf` identified its stale direct Host effect fixture. The current updates-disabled real producer reached the complete equality assertion and failed: one selected case failed, 186 were unselected, with 24 effects preserved. Entry 4 (`runtime-reference` / `reference.import`) retained a 15-Tool, 9166-byte package instead of the current 17-Tool, 9215-byte package. Exact current RED is `evidence/L-GA/request-next-host-red.log`; this is an observed assertion failure, not setup.

Regeneration used the existing documented `OPENKIT_UPDATE_EFFECT_FIXTURE=1` actual producer, one worker and no file parallelism. It passed. Comparing all effects and decoded bytes against the saved pre-change fixture proves that only entry 4 input/command body, length and SHA changed. The decoded package differs only by appending `vault_grant_request` and `vault_grant_request_list` to the existing generative Tool list and its derived catalog digest. Replacing those fields reconstructs the exact complete body and fixture bytes. Other authored fields, effects and their order are unchanged. Exact comparison is `evidence/L-GA/request-next-host-comparison.log`; generation output is `request-next-host-regenerate.log`.

The NanoHost guide explains this accepted request-only Tool inventory and uses the owning-app Rust invocation so its app-local toolchain applies. Updates-disabled verification passed in `evidence/L-GA/request-next-host-green.log`: both selected native producer/dispatcher pins passed, with 200 unrelated cases unselected. The owning-app Rust consumer passed one selected test, with 382 unit cases filtered out; unrelated integration targets ran no selected cases. Cargo completed its test build in 2m 37s without changing the toolchain. Documentation model (527 documents), lifecycle/index and whitespace also passed. This correction changes only the fixture, its local guide and this plan. No runtime, test, schema, identifier, Server, catalog, session, preview or Equal source is changed. R2 remains open for actual P14 API integration before review and landing; no identifier spelling is guessed or pre-approved.

## R2 — Actual P14 Integration

Normally merge prepared Server/P14 parent `4ceaa9e0ad3687843754ff13d987faafdf82d405`, which contains the actual committed P14 API `e2493a138cdef6d204afbd1c9d6ef471647661cc`. No changing remote or independently reworked Server/common join is imported. Request-owned Turn, Item, VaultGrant and PermissionDecision allocation uses `allocateEntityId` with its existing kind and allocation trigger; Worker Turns and exact request replay retain their recorded identities. Named public/captured entity fields reuse Protocol validators, while request, Approval, Agent, MCP and native selectors remain opaque under their existing owners. No generator, tag, compatibility reader or derivation is added.

Existing native, App API and Web fixtures use recorded canonical identities and otherwise valid unknown targets so authority and canary negatives still reach their subject. The actual nonmember administrator session and persisted product-policy provenance oracles remain. R1 uses the accepted P14 parent Host fixture and actual producer, not the prior 9215-byte old-format Tool package. Its current accepted comparison baseline has 24 effects and a 9639-byte/15-Tool package; observe the real producer before regeneration and preserve every other P14 field and authored byte. Normal merges also retain Preview/P14 parents `d6b4e72a2ac4841672af93f2702c9fc579c00086` and `463323b79fc15b7fe94a2d686697c7ab3baec9dd`, including the P14 test/fixture corrections without a production identifier change. The Request feature is 40 paths against the latter parent. No Equal adapter or Preview/catalog/session behavior change is imported. This preparation is not final main integration, independent acceptance, a full gate or browser proof.

The actual focused pipeline passed all 26 Native Request and four App API cases, Native/dependency/CoreClient builds, CLI/OpenAPI generation and validation, and Native/Web types. Its initial Web result was 36/40: four custody-added button labels still named pre-P14 fixture identifiers. The labels now use the canonical retained fixture records; all transport/cache refusal and transient clearing assertions remain. The complete corrected Web run passed 40/40, and actual CLI/OpenAPI regeneration on the newer parent passed. Final parent typechecks, all 89 Skill/Web inventory cases and focused Biome passed. Raw outputs are `request-p14-focused.log`, `request-p14-web-generation.log` and `request-p14-final-types-inventory.log` under the external backlog evidence directory.

The actual updates-disabled Host producer failed at complete fixture equality, one selected case with 186 unselected: its 15-Tool, 9639-byte P14 body needed the two Request tools and 9688 bytes. Documented real producer regeneration passed. Complete comparison preserved all 24 effects and order, changing only effect 4 input/command body, length and SHA. Decoded package changes are exactly the two Request built-ins and derived catalog digest; reconstruction matches complete generated bytes. Accepted parent bytes and the comparison method/results remain in external `request-p14-host-parent-before.json`, `request-p14-host-comparison.mjs` and `request-p14-host-comparison.log`; the actual failure is retained in `request-p14-host-red.log`. Updates-disabled native producer and dispatcher pins passed, two selected cases with 200 unselected. The app-scoped locked Rust consumer passed one selected test with 382 unit cases filtered; unrelated integration targets ran no selected cases. Exact output is `request-p14-host-regenerate-green.log`. R1 and R2 now have bounded producer evidence on this committed-parent integration; final actual-main dependency join, independent review, full gate and browser proof remain open.

## Equal-Member Parent Integration

Normally merge concrete Equal parent `58a2a32586d76ec3e2ba44cae4a02ac39fdeaa77` into Request `3a12a14a04a22e54126bdd5355ef6af88ddfa002`. This is dependency preparation, not acceptance of the Equal feature. Request authorization already consumes current Workspace eligibility as a boolean and records reviewed administrator product provenance; it has no membership-tier adapter to replace. Native administrator gates, actual deciding credential, per-effect grants, private audience and request lineage remain unchanged. The package guide retains both complete features. The public inventory removes the retired member-access operation and uses the actual source-derived count of 263 operations: 76 Server, 185 ordinary and two Gateway. Runtime inventory confirms that count. Corrected Equal source parent `f10b5667cd7d0e00a9dc7d802490de5d1ea593ab` and final code parent `2a909a1c50e217a9b2c53e5eef4a535ae967fce7` are normally merged. The latter changes one unrelated Worker fixture line only; production, schema, API and generated inputs are unchanged. Separate Equal acceptance and final main reconciliation remain outside this Request preparation.

The accepted Request Host fixture remains byte-identical at the ordinary merge: 24 effects and a 17-Tool, 9688-byte package body. An updates-disabled actual producer check must decide whether this parent changes the package; no body, length, hash or normalization is guessed. Regenerate only if that deciding check requires it, through the documented producer and complete comparison. Generated CLI/OpenAPI joins use the actual merged definitions. No independent Equal source correction, new mechanism, compatibility path, full gate or browser claim is authorized by this preparation.

The owned Host fixture's focused Biome check found two expanded single-item `binaries` arrays from actual producer JSON output. The existing formatter compacts those arrays. Complete parsed comparison against the saved Request parent confirms all 24 effect records and both package body byte strings remain identical; no material, command field, Tool inventory, body length, digest or hash was rewritten. The actual formatting failure and correction are retained in external `request-equal-host-format.log` and `request-equal-host-format-green.log`. This is an outer JSON formatting correction, separate from the actual producer check.

The first dependency preparation failed Native compilation on duplicate deletion-recovery declarations inherited from the concrete Equal WIP. Its producer supplied the committed correction; Request made no independent Equal source edit. The corrected pipeline passed Native/dependency/CoreClient builds, actual CLI/OpenAPI generation and validation, both typechecks, four App API cases and all 26 Native Request cases. Its Web run passed 39/40: the canary fixture omitted the existing `core.meta()` connection probe, which disabled submission before validation when retry completed. The fixture now supplies the existing reachable probe pattern and asserts submission is enabled before clicking. The complete corrected Web run passed 40/40 without changing production behavior, retry policy, refusal or custody assertions. Raw failures remain in `request-equal-generation.log` and `request-equal-focused.log`; final consumer output is `request-equal-final-consumers.log`.

Final consumer verification also passed all 89 Skill/Web inventory cases, focused Biome including the Host fixture, both updates-disabled Host producer/dispatcher pins (two selected, 200 unselected), documentation model (532 documents), lifecycle/index, test governance and whitespace. All 24 parsed effect records and both complete 17-Tool, 9688-byte package bodies remain identical to the saved Request parent. The actual producer required no package regeneration; no new Rust consumer run is claimed for an unchanged fixture body. The existing R2 app-scoped Rust proof remains named above. The final test-only Equal merge changes neither generated output nor Request executable source. Request remains 40 paths against that final code parent; full exact gate, browser checks, independent acceptance and actual main-parent integration remain open.
