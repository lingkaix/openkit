---
type: change-plan
status: verified
started: 2026-08-30
branch: main
---
# Scope-Aware Web Navigation And Session Administration

## Intent Epochs

### Intent Epoch 1 — 2026-08-30 — User request

- **Outcome:** Reorganize the Web shell so Workspace work and state are visibly separate from user, server, and administration settings, move Workspace switching into the global sidebar header, place the current Workspace chat list in the sidebar middle, and remove manual server-admin bearer entry from Web settings.
- **Non-negotiables:** Keep Knowledge and Artifacts prominent, provide compact Workspace-resource entry icons above the bottom Settings command, support multiple server-admin Tokens assigned to one canonical User, let that User select one default, automatically select the sole Token, and let NanoCore authorize eligible browser sessions without exposing or persisting plaintext Token material in Web.
- **Acceptance:** Scope placement remains truthful under Workspace changes; thread routes cannot retain stale Workspace lineage; user/server/admin settings are visibly grouped; Configuration and AI interface work from an eligible Better Auth session; administrators can issue and revoke server-admin Tokens for another exact `ownerUserId`; a User can inspect only their assigned safe metadata and select a default; revocation and expiry remove derived session administration on the next request; focused schema, Core Client, NanoCore, Web, OpenAPI, lint, typecheck, and build checks pass.
- **Exclusions:** No compatibility aliases, no user-directory browser, no new secret store, no server-side plaintext Token recovery, no unrelated Workspace capability work, and no deployment or publication.
- **Effect boundary:** Repository documentation, schemas, NanoCore auth and Token routes, Core Client, and Web projection only; no live server, credential file, deployment, or external API mutation is authorized by this record.

### Intent Epoch 2 — 2026-08-30 — Sidebar search and Workspace context correction

- **Outcome:** Remove the persistent Search bar above routed main content, put an icon-only Search entry at the right of the brand row, and move the persistent Workspace switcher below the brand and above Overview so the selected Workspace name remains continuously visible.
- **Navigation correction:** Move Portability and New workspace into User Settings; follow the common Workspace page destinations with a visible divider and distinct current-Workspace Chat and Task lists; keep the compact Workspace-resource icon row above the Settings footer.
- **Agent correction:** The Agents surface must list and operate only on Agents bound to the selected Workspace and must not merge Agent rows from other authorized Workspaces.
- **Acceptance:** Search remains reachable from the sidebar without a main-content header strip; Workspace selection remains usable and legible; switching rebinds all Workspace content; App mode does not show Portability or New workspace; Chat and Task rows are visually separated from common destinations and from each other; Agents has selected-Workspace-only query ownership.
- **Evidence reconciliation:** `ThreadSchema` owns no Chat or Task discriminator, Task Mode deliberately owns no durable Task record, and both modes operate in the same Thread. A split list would therefore be a false projection. The smallest truthful acceptance is direct **New conversation** access plus one selected-Workspace **Conversations** list of active Threads below the divider; a durable delegated-work tree requires the separately accepted `parentThreadId` work package and is outside this UI change.

### Intent Epoch 3 — 2026-08-30 — Archived Threads, title-bar economy, and canonical Chat lineage

- **Outcome:** Add current-Workspace Archived threads to the compact Workspace access row, exclude archived rows from the active Conversations list, and allow an archived Thread to be restored through the existing status update contract.
- **Thread chrome:** Treat the Thread title bar as scarce space; Rename and Archive are icon-only actions immediately beside the Thread name, while the Side panel toggle is icon-only and right-aligned. Every icon action has an accessible name and hover or focus hint.
- **Side panel terminology:** The optional right rail is named **Side panel** and currently indexes the Thread's Artifacts and file changes; it is not the global Artifact inventory and may later carry other Thread auxiliary information without changing the required center workflow.
- **Workspace selection:** The persistent sidebar control is the only Workspace switcher in published Web; Chat starter, Thread pages, and all other main views render none.
- **Route contract:** A Chat Thread uses `/chat/:workspaceId/:threadId`; the former query-string Workspace lineage is removed without a compatibility redirect, and every producer and consumer of Chat links uses the canonical path.
- **Acceptance:** Archived and active lists are mutually exclusive and selected-Workspace-bound; Restore changes the authoritative Thread status to active and refreshes the lists; title actions preserve name space and keyboard accessibility; the Side panel label is accurate; no non-sidebar Workspace switcher or legacy Chat Thread URL remains.

## Accepted Owners

- `docs/core/identity.md` and `docs/core/permissions.md` own identity and deployment authority semantics.
- `docs/specs/20260704-remote_auth_credential_bootstrap.md` owns human access-token lifecycle and browser-session separation.
- `docs/specs/20260715-multi_user_workspace_system.md` owns canonical User and server/workspace authorization scope.
- `docs/specs/20260628-web_product_surface_projection.md` and `DESIGN.md` own the Web projection posture and visual information architecture.
- `docs/specs/20260528-core_client_boundary.md` and `docs/specs/20260704-app_api_openapi_projection.md` own schema, client, route, and OpenAPI alignment.

## Accepted Decisions

- NanoCore will not recover or internally replay plaintext bearer Tokens because the durable authority stores only hashes.
- A Better Auth session may receive deployment-admin authority only from a currently usable `server-admin` Token record owned by the same active canonical User.
- The Actor keeps session authentication distinct from bearer authentication and carries the selected non-secret administration Token identity only for authorization and attribution.
- One explicit per-User default Token identity is stored as server-owned authentication metadata; when it is absent or unusable, NanoCore deterministically selects a usable owned Token, so one available Token is automatically effective.
- Existing `openkit_access_tokens` rows remain the sole durable deployment-admin authorization records; no parallel grant entity, schema migration, or Token-secret recovery path is added.
- Derived session authority is resolved on every request, never updates bearer `last_used_*` evidence, and treats a rotated Token as usable only during its existing rotation grace period.
- A dangling, revoked, expired, wrong-scope, or foreign default pointer never grants authority; NanoCore falls back to another usable owned `server-admin` Token or denies administration.
- Token administration accepts local authority, an actual `server-admin` bearer, or a session with derived deployment-admin authority, while ordinary Workspace content continues to require the session User's current membership and policy authorization.
- Workspace pages remain Workspace-bound even when reached from compact navigation; Settings contains only user, server, and administration groupings.
- The sidebar projects the existing current-Workspace Thread list only; this change does not implement the roadmap's complete collapsible multi-Workspace and Thread tree.
- The brand row owns Search rather than Workspace selection; the persistent selected-Workspace switcher sits immediately below it and above common destinations, while the main content has no shell-level pinned Search strip.
- Portability and New workspace are User Settings destinations; direct New conversation access plus the existing current-Workspace active Thread collection appear below a visual divider as one truthful Conversations list.
- The Agents projection reuses the selected Workspace resources read instead of the cross-Workspace Agent catalog list.
- Archived threads are a selected-Workspace compact destination, the active Conversations list excludes them, and Restore reuses the existing Thread status update rather than adding an API.
- Thread title actions prefer icon-only controls with hints; Rename and Archive stay beside the name, while the optional right rail is called Side panel and its toggle stays at the far edge.
- Published Web has one Workspace switcher, and Chat Thread identity is encoded as `/chat/:workspaceId/:threadId` instead of a query parameter.

## Working Checkpoint

- **Current facts:** Web now has one persistent selected-Workspace switcher below the brand row, sidebar Search without a pinned main strip, selected-Workspace compact destinations and active Conversations, archived Thread restoration, canonical owner-complete Thread routes, compact Thread title actions, and no page-local Workspace selector or manual administration credential form.
- **Authority result:** NanoCore resolves Token-derived session deployment administration on every request from currently usable owned `server-admin` Token records, preserves the session actor kind, stores only one optional non-secret default Token ID per User, rejects unusable or foreign defaults, and keeps ordinary Workspace access under current membership and policy authorization.
- **API result:** Administrators can issue a Token for another exact active canonical `ownerUserId`, with target-owner membership validation for Workspace scopes; session-only self-service routes expose redacted owned admin Token metadata and accept one usable default selection through schemas, Core Client, OpenAPI, and Web.
- **Scope result:** The operation catalog, deterministic generated OpenKit CLI bundle, and root operation-surface contract tests are in-scope repository projections required by the accepted API additions; they add no separate product behavior or external effect.
- **Method result:** Cursor CLI with Grok 4.6 High produced and tested the bounded implementation, while root reviewed the actual diff and integrated the accepted result. Earlier Claude sessions supplied supplementary independent review evidence but were dispatched too deeply into implementation detail; the final durable-commitment gate is therefore being rerun as the repository-defined fresh-context verifier direction check.
- **Frontier:** Implementation commit `9cbf3046` records the complete accepted product and projection scope. The role-correct verifier's sole governance correction is present in that commit, and no unresolved finding, unowned decision, engineer trade-off, or external effect remains.
- **Next Action:** None. The change is closed.

## Closeout Summary

Implementation commit `9cbf3046` records the accepted change. The Web shell now presents one persistent Workspace context, scope-separated navigation, archived Thread recovery, canonical owner-complete Thread URLs, compact Thread controls, and session-backed administration without a browser-entered server-admin credential. NanoCore reuses existing Token records as the sole deployment-admin authority, adds only a non-secret per-User default pointer, and keeps Workspace membership and policy authorization unchanged.

## Verification Evidence

- **Behavior evidence:** Web route, navigation, Search, Workspace switch, Thread chrome, archived restoration, selected-Workspace Agent, settings-scope, Configuration, AI interface, access-token administration, and default-selection regressions are included in the 863-test Web suite; NanoCore focused auth, Token-store, NanoHost administration, and OpenAPI coverage passes 61 tests.
- **Contract evidence:** `@openkit/app-api-schemas` passes 114 tests, `@openkit/core-client` passes 75 tests, the two root operation-surface suites pass 15 tests, OpenAPI generation and validation pass, and the ordinary-user operation guard accounts for all 141 included operations.
- **Repository evidence:** Under mise Node v24.18.0, affected-package lint, typecheck, and build checks pass; `pnpm test:unit` passes all 13 package suites plus 527 root tests after the deterministic generated CLI bundle is staged; `pnpm check:repo` validates lifecycle metadata, story schema, documentation model, documentation index, Agent Skill reachability, AgentSession terminology, test governance, 945 formatted files, and the models.dev catalog.
- **Review evidence:** Root inspected the final implementation and generated bytes, `git diff --check` passes, the isolated Web full suite passes 863 tests, the NanoCore full suite passes 2480 tests, OpenAPI and CLI bundle regeneration preserve their exact SHA-256 values, and no compatibility route, manual admin Token entry, duplicate Workspace switcher, unrelated deployment effect, or uncommitted external research artifact remains.
- **First independent audit evidence:** A fresh Claude Code Opus audit inspected the actual diff and returned `Continue` for stale generated bytes, incomplete hover/focus hint proof, inventory arithmetic, dead exports and helpers, duplicated compact-navigation ownership, missing derived-token audit attribution, client-side Token usability duplication, a full-table Token scan, stale Portability scope copy, and one missing NanoHost denial regression; the subsequent Grok corrections and root checks close every enumerated finding before the new final audit.
- **Second independent audit evidence:** A second fresh Claude Code Opus audit independently reproduced all package and repository gates, confirmed the first-audit findings closed, and returned `Continue` only for 41 stale bearer-only deployment-admin OpenAPI projections, fixed AI-interface query-generation plumbing, and plaintext mutation data retained after Token dismissal. Cursor CLI Grok 4.6 High aligned all 45 documented deployment-admin operations with bearer-or-session runtime behavior, collapsed the fixed query key, and cleared issue and rotate mutation data; an independent Grok tester then passed OpenAPI 23/23, Web settings 16/16, focused Biome and typechecks, OpenAPI validation, a catalog-to-generated-security probe, and `git diff --check` with no product finding.
- **Third independent audit evidence:** A third fresh Claude Code Opus audit inspected all 79 changed paths, re-ran the full Web and NanoCore suites plus schemas, Core Client, operation surfaces, validators, typechecks, Biome, and deterministic OpenAPI and CLI regeneration, and confirmed every earlier security and behavior finding closed. Its `Continue` was limited to obsolete Side panel comments, a stale Web directory map, four duplicated OpenAPI security literals, and two stale NanoCore comments; Cursor CLI Grok 4.6 High corrected those exact mechanical findings, and an independent Grok tester passed OpenAPI 23/23, Web and NanoCore typechecks, focused Biome, OpenAPI validation, documentation model/index/lifecycle checks, and `git diff HEAD --check` with no finding.
- **Supplementary independent review evidence:** A fourth fresh Claude Code Opus 5 xhigh session inspected the complete 82-path staged and unstaged diff, directly rechecked the requested Web and authorization boundaries, confirmed deterministic OpenAPI and CLI bytes, ran the full Web and NanoCore suites plus schema, Core Client, root contract, typecheck, Biome, OpenAPI, and documentation checks, found no blocking issue, answered the repository Completion Gate with the expected results, and returned `Close`. This remains useful evidence but does not substitute for the repository-defined verifier direction gate.
- **Commit-direction verifier evidence:** A fresh Claude Code context followed `.codex/agents/verifier.toml` as a governance direction check, read only the current Intent, checkpoint, Git state, commit authorization, and named evidence, and did not inspect code or rerun technical tests. It found the authorized commit direction sound and the evidence fresh, returning `Continue` only for the repository projection scope line corrected above, with no further direction check owed for this commit.
