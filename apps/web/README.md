# @openkit/web

The conversation stream uses the authorized dashboard taskInputs summaries for verified Worker request objectives. View request details retains the exact original message; absent summaries and ordinary human JSON remain verbatim.

Status chips retain their full single-line label under flex pressure; surrounding descriptions wrap instead. Goal attention explanations appear as full body text below the short status label.

Conversation messages and the active Turn header resolve authorized participant names from the Thread dashboard by exact actor kind and id; the header marks the current human as You and retains recorded ids when a name is unavailable. Only the authenticated human aligns right with a You marker; other humans use left-aligned circular avatars and bubbles, while agents use square avatars and unboxed content. Missing profiles retain recorded ids, and messages without exact agent provenance show Agent. Account transitions discard viewer-bearing dashboard caches. An open Chat or Task Thread refreshes its existing dashboard observer every 5s in the foreground, including during execution so newly verified request summaries become visible. Its item observer polls only while idle, so another client's completed Chat turns appear without reload even when dashboard and items arrive in different orders; a running Turn keeps SSE as the sole live Item writer. Administration does not opt into this poll, and other Threads or Workspaces are not refreshed.

The OpenKit Web UI — a React SPA that projects stable NanoCore / App API
contracts as a supervisor's workbench. This is the rebuilt app; the previous
SolidJS + daisyUI implementation is retired and is not a current reference tree.

## Scope

The Web UI is a **projection** over NanoCore read models, not a source of kernel
semantics (see [`docs/specs/20260628-web_product_surface_projection.md`](../../docs/specs/20260628-web_product_surface_projection.md)).
It consumes the server only through the composed `@openkit/core-client`
sub-clients. Design intent — information architecture, the three themes, the
component grammar, and the weak-interaction interaction model — is owned by the
canonical [`DESIGN.md`](../../DESIGN.md) at the repo root.

The published Tier-A **AI interface** and **Configuration** screens are separately authorized deployment-administration workflows inside the Settings shell. They use the current browser session only: NanoCore derives deployment-admin authority when the signed-in active canonical User owns a currently usable `server-admin` Token, so Web never asks for, stores, or replays Token plaintext. AI interface subscription-account cards show a name and status header, full quota windows with browser-local reset and last-checked times, Refresh quota as the primary action that updates only that provider-slot observation, and rename, logout, and delete under a disclosure; the create-slot form stays collapsed until requested. A window without provider-supplied percentages shows usage as not reported and keeps its known period and reset time without a percentage meter. xAI cards show observed plan and shared-allowance information; Balance and costs discloses signed USD prepaid balance, extra spend and cap, and fetches independent auto-top-up rules only when expanded. Refresh updates only that account and reloads its rule while costs are open. Missing amounts and rule status remain unknown, while explicit zero and disabled remain visible. Account settings includes observed Build subscription eligibility, which does not claim effective coding permission. Full local times and time zones are inspectable on each timestamp. A failed refresh clears stale quota amounts and meters rather than presenting them as current. A non-authorization quota read failure remains local to its card with no invented observation timestamp, while HTTP 401/403 closes account controls and retains the screen retry path. General Workspace settings share the Settings shell under Workspace, read only the selected Workspace, offer display-name editing and a Knowledge entry, and never request deployment diagnostics or runtime config. Configuration keeps a collapsible, keyboard-navigable relative-path file tree beside the editor on wider screens and above it on narrow screens. **Hide files** expands the editor workspace without losing the current draft or folder expansion state; the full selected path stays visible in the editor heading. Everyday configuration is directed to NanoCore’s **Server Operation Agent** in Administration (`submitAdministrationConversation`) with user-granted permissions; the generic file editor remains available for inspection and careful manual edits. Configuration uses the existing `client.runtimeConfig` file, validation, revision, and safe-reload contract. Its **Show schema** control reads `client.runtimeConfig.getSchemas()` on demand and displays the selected file kind's server-owned JSON Schema in a scrollable reference. Schema failures offer explicit retry while preserving the configuration draft; an absent kind is shown as unavailable.

The Tier-A Settings **Administration** screen uses the same session-derived deployment-admin authority without accepting Token plaintext. Its private administration conversation is a distinct Thread entry in the current User's Quick Chat Workspace and continues only through the dedicated administration conversation endpoint. Catalog configuration candidates are discovered from the same authorized private Thread Artifact references as environment candidates, bound to exact Artifact version and content digest, and shown with target provider or gateway identity, before/after editable metadata, base revision, and restart impact. Application is never model-applied: the administrator uses **Review configuration** then **Apply configuration** through `client.app.applyAdministrationConfiguration` with payload-bound confirmation. A recorded apply outcome Artifact for that exact candidate is shown as persistence, reload, and restart separately; unknown or failed application disables Apply rather than repeating the command. Environment preparation reads an actual published Server Agent manifest and its exact configuration SHA, then keeps authored and resolved candidates in that private Thread. Result-only recovery uses the exact authored Artifact; human activation reuses the response's payload-bound confirmation and shows the shared Agent's later-admission scope, optional exact current Thread and successor prompt, configuration result, and each retained environment disposition. The globally selected Workspace separately scopes immediate-replacement Thread selection, the retained Worker environment list, current host status, and explicit whole-environment deletion. Environment inspection labels the returned Core association state and revision separately from host storage state and attachment; host availability alone does not establish reuse eligibility. Deletion is bound to the displayed environment revision, and an unknown host result requires a fresh status inspection before another effect request. The exact private candidate also determines a stable application request ID, so a fresh render cannot turn an uncertain command into a new write request.

The accepted ordinary Workspace Vault placement is read-only and uses exactly `client.app.listWorkspaceVaultReferences`, `client.app.listWorkspaceVaultGrants`, `client.app.listWorkspaceVaultInjectionPlans`, `client.app.listWorkspaceVaultInjectionReceipts`, and `client.app.listWorkspaceVaultUseRecords` for the selected Workspace. It does not request or project deployment-admin backend status. The separate Tier-A Settings Administration **Vault backend** surface at `/settings/vault-admin` uses `client.app.getVaultAdminStatus()`, `client.app.unlockVaultAdminBackend({ masterKeyBase64 })`, and `client.app.lockVaultAdminBackend()` with session-derived deployment-admin authority. It projects backend kind, state, and redacted diagnostic. When unlocked, its selected-Workspace secret panel lists redacted references and grants, accepts new or replacement material through a password field, creates host-push grants, and revokes secrets or grants. Secret fields clear on submission and Workspace changes; mutation responses are discarded and only whitelisted inventory is cached. Bind a host-push grant using the public repository operation documented in the Vault recipe. Unlock accepts an existing base64 master key through a password field cleared on submission; key material never enters query or mutation caches, browser storage, URLs, or errors. Lock and unlock require explicit actions and refresh status on success. Pending requests block overlapping actions and key edits; denial hides status, and Retry rechecks status without replaying a mutation. The permission and multi-user Workspace specifications own that authority separation.

The live Tier-A board-17 **Usage & audit** screen is implemented as a read-only projection scoped to the selected Workspace. It uses exactly `client.app.getCapabilityUsage`, `client.app.listWorkspaceAuditEvents`, and `client.app.listWorkspacePermissionDecisions` with that validated Workspace, and it never calls or projects `client.app.listServerAuditEvents`. The separate Settings **Server audit** surface at `/settings/server-audit` reads `client.app.listServerAuditEvents()` and `client.app.listServerPermissionDecisions()` independently of Workspace selection. NanoCore derives deployment-admin authority from the current browser session; Web never requests Token plaintext and shows access denied with explicit retry. Both surfaces whitelist and redact display metadata before caching, omit private payloads, and remain read-only. Server audit does not claim complete deployment audit coverage.

Shared audit rows preserve the recorded event time (`occurredAt`, falling back to `createdAt`) and permission-decision creation time in their safe display projection. Server audit remains deployment-admin scoped; Usage & audit remains selected-Workspace scoped. Both show local date/time with its timezone and retain the exact ISO timestamp in semantic `time` markup; missing time is explicitly unavailable. Usage measurements additionally show their recorded time and logical-model attribution. Known Gateway input, output, cache-read, cache-write, total and estimated-cost sources receive distinct display labels; unknown sources retain a neutral label rather than an inferred metric. Measured rows precede a collapsed capability-call disclosure. Raw source strings, provider/runtime identifiers and payloads stay outside the display projection; no aggregate or billed-cost claim is derived from these rows.

Typed Workspace access denial shows an explicit repository-access message without a futile retry; other repository read failures retain retry. The live Tier-A board-19 **Repositories** screen projects selected-Workspace repository resources, diagnostics, default-repository setup, durable push records, and the existing approval-gated Git push workflow through `client.repositories`. It requests approval for one exact target, executes only a matching granted approval, and re-reads the authoritative repository projection without adding an API or external-effect owner. Its approval response remains TanStack mutation data, and its route appears once in the compact sidebar shortcut grid alongside the Settings gear. Workspace Sync review-to-apply is a separate live **Workspace changes** surface. Review cards prioritize changed paths, status, risk and change counts; exact record identifiers and full diffs remain available through native disclosures. Low-level synchronization inventories stay under diagnostics, while apply results and recovery decisions remain visible. The selected Workspace is controlled only by the persistent primary switcher below the sidebar brand row; page-local switchers are absent, active Threads share one Conversations list because Chat and Task are modes on the same Thread, and archived Threads have a compact destination with Restore. Focused tests cover this Web projection; no real external push is claimed here.

The live Tier-A **Catalog** screen projects selected-Workspace Skill, MCP, and Agent Plugin catalog management through `client.catalog`. It imports SKILL.md files or Skill folders, pins current Skill versions, creates inactive MCP configurations, toggles enablement, and imports plugin.json packages. Fresh Skill and MCP fields keep actual values empty and show examples only as native placeholders; Skill file and folder import stay disabled until a display name is entered. Directory uploads snapshot selected files before resetting the native input, so the live FileList cannot disappear during submission. Browser File API folder uploads include regular files only and cannot preserve executable flags or empty directories. Native Codex plugin loading is not advertised. Stdio MCP enablement remains a deployment-admin authority on the server. Writes stay disabled while disconnected.

The live Chat surface renders `generative-ui-reference` Thread Items through the eight native A2UI types mapped onto OpenKit primitives. Kernel create and record writes stay agent-first. The `/generative` fixture shell remains unpublished Tier C.

Surfaces that run ahead of a stable kernel contract may retain internal review implementations, but published navigation and routing omit them until they become live (DESIGN.md §11).

The Settings **Debug** surface contains the component catalog and is the single Web placement for future developer-facing inspection panels after their contracts and authorization are accepted.

Shared Modal surfaces stay within the padded viewport and scroll long content so confirmation controls remain reachable. React Aria continues to own focus containment, Escape dismissal and focus restoration.

Settings **Deployment backup** at `/settings/data-root-backup` creates and verifies deployment data-root backups through `client.app.createDataRootBackup()` and `client.app.verifyDataRootBackup(backupId)`, independently of Workspace selection. It uses session-derived deployment-admin authority with access-denied retry and no Token plaintext. Creation is explicit; verification accepts the returned ID or a known ID. Summaries whitelist the backup ID, mode, consistency, start/completion timestamps, file count, total bytes, and checked-file count; inventory paths and raw errors are omitted. Retry never automatically repeats creation.

Settings Administration **Workspace access recovery** at `/settings/workspace-access-recovery` explicitly loads `client.app.getWorkspaceAccessRecoveryState(workspaceId)` and submits `recoverWorkspaceAccess(workspaceId, input)` with a new request ID and the loaded registry revision. It shows only workspace ID, owner user ID, administrator role, and registry revision; transfer-to-self requires typing the workspace ID. **Disable user** at `/settings/disable-user` starts with no target and requires matching typed user ID confirmation before `client.app.disableUser(userId, input)`. Its summary contains only user ID, disabled status, and disabled timestamp. Both surfaces use the signed-in session’s derived deployment-admin authority with no Token plaintext; denial hides results and Retry probes access again. Mutation errors never automatically replay actions, and recovery failures require a fresh state load.

Settings **App update** projects deployment-admin prepare, start and status operations through `client.app`. It is scoped to the deployment, independent of the selected Workspace. The administrator reviews an immutable prepared source and explicitly consents to maintenance; the host receipt owns the result across App restarts. The deployed host helper must be configured before this surface can perform an update.

Chat and Task Composer target availability follows changes to the current Thread's latest observed Turn identity or status, including SSE completion and the existing foreground dashboard refresh. Only that Thread's target catalog is refreshed; NanoCore still decides whether a Worker is available.

The shared Composer begins directly with the message input on starter, Chat, and Task surfaces. Conversation titles and mode labels do not consume input-box space; selected attachments remain removable below the input. The existing `+` chooser exposes Advanced settings for new Task Worker work: default new environment or explicit retained-environment reuse, with readable source provenance, labeled local creation time to distinguish same-source environments, and eligibility. Selection previews use the existing administrator-scoped environment reads; structured submission forwards the exact choice for send-time revalidation by actual receiving-Thread admission, preserving idempotent replay after transport uncertainty; errors retain the draft and choice rather than silently creating fresh storage. No additional permanent action-row control is added.

Goal projects one Draft › Plan › Execute › Review strip from the current durable Goal status. Its bottom input is a steering-only labeled textarea (`submitThreadGoalSteering`) with Enter to send, Shift+Enter for a newline, and IME-safe composition; Agent, logical-model, and attachment Composer controls are absent. Plan recovery reads `client.app.getThreadGoalPlan` and creates a plan only when that GET Goal is `planning`, reusing the caller request id across uncertain create retries for the same Goal. Local spend/push switches remain presentation-only and do not write Goal autonomy. Plan and completed closeout keep a distinct authored title as the heading; when title equals objective they use a short heading (`Goal plan` / `Goal completed`) and show the full objective once as wrapped body text. Before plan approval, the Plan card native details project the current GET plan as labeled wrapping text (summary, assumptions, risks, empty questions as no open questions, verification approach, and each task's objective, criteria, token budget, resources, outputs, checks, human review, dependencies, and escalation); opening details does not mutate, and Approve still sends only the exact `planItemId`.

Thread header icon commands use 20px glyphs in 32px square buttons without inherited horizontal padding. Shared icons retain their declared width inside flex layouts and inherit the active theme foreground. Task thread headers show the sidebar Worker-task glyph at 20px in a nonshrinking titled span labeled Task.

The Thread Side panel indexes each referenced Artifact version once, even when multiple Turns attach it. Conversation history retains every reference, and file-change records remain individually visible.

## Stack

Fixed by [`docs/specs/20260710-web_ui_rebuild_stack.md`](../../docs/specs/20260710-web_ui_rebuild_stack.md):

- **React** (Vite) — scaffolded with the official `create-vite` `react-ts` template.
- **React Aria Components** — accessible behavior for the primitive tier.
- **Spectrum-derived semantic tokens → Tailwind CSS v4** — the current hand-maintained token bridge in `src/styles/`
  (`tokens.css` = semantic tokens for the three themes; `theme.css` = the Tailwind
  `@theme` mapping). Component markup references semantic tokens only. Direct use
  of Adobe's token package remains a stack-conformance gap.
- **Zustand** — UI-only state. **TanStack Query** — server state over `core-client`.
  The two never overlap.
- **React Router** — routing.
- **jsonc-parser** — scanner-only JSONC syntax highlighting for the native configuration textarea; NanoCore remains the parser and validator.
- **markdown-it** — the parser already supplied by A2UI, directly configured for readable assistant reports. Raw HTML is disabled, images remain escaped text, and only explicit HTTP(S) links are navigable. Human messages and raw evidence remain verbatim; the Web projection does not change API or Skill message text.
- **A2UI native Chat renderer** — live Thread Items of type `generative-ui-reference` render through official `@a2ui/react@0.11.0` v0.9. The unpublished `/generative` fixture shell remains Tier C.
- **Iconify + Remix Icon** — icons for the primitive and screen tiers.
- **Biome** — lint/format (repo-wide config). **Vitest** + Testing Library — unit.
  **Playwright** — e2e.

The isolated simulator-backed Web stack seeds a visibly synthetic local NanoHost Epoch after Core startup and after a Core restart in its disposable data root, matching the simulator unit-test precondition. Non-simulator stacks receive no synthetic readiness. Production backend-session validation stays enabled. These checks prove Web and Core interaction against the simulator; they do not prove real NanoHost readiness or Worker execution on a deployed server. The Material self-check exercises Artifact review and acceptance at 800×600 without page-level horizontal overflow. shell-smoke verifies Settings and Chat at 600 and 742 without page-level horizontal overflow, and persistent left navigation at 800.

## Commands

```bash
pnpm --filter @openkit/web dev         # Vite dev server (proxies /api → VITE_CORE_BASE_URL or :3000)
pnpm --filter @openkit/web build       # tsc -b && vite build
pnpm --filter @openkit/web test        # vitest run
pnpm --filter @openkit/web typecheck   # tsc -b
pnpm --filter @openkit/web lint        # biome check .
pnpm --filter @openkit/web e2e         # L4 Playwright smoke (isolated NanoCore + Vite)
```

For single-file focused evidence, invoke the installed Vitest entry point directly:

```bash
pnpm --filter @openkit/web exec vitest run src/primitives/primitives.test.tsx
```

Use the settings test file as the focused package check for the Vault surface:

```bash
pnpm --filter @openkit/web exec vitest run src/screens/settings/settings.test.tsx
```

This command provides focused package evidence for the Vault assertions; it does not replace the required independent strict-risk review and verification.

The package `test` command remains the full-suite command. Adding `-- <file>` to it has been observed to run the full suite, so do not use that form as focused evidence.

`e2e` expects a built NanoCore (`pnpm --filter @openkit/nanocore build`). Specs start an isolated stack on dynamic ports via `e2e/_lib/servers.ts` and set `VITE_CORE_BASE_URL` so the SPA talks to that Core.

Run the self-contained root gate with `pnpm -w test:e2e:web`; it builds NanoCore before invoking the Web `e2e` command.

Run alongside NanoCore for the product loop:

```bash
pnpm --filter @openkit/nanocore dev   # start the core first
pnpm --filter @openkit/web dev        # then the SPA
```

## Structure

```
src/
  main.tsx            app entry — mounts <AppProviders><App/></AppProviders>
  App.tsx             root app element
  app/                shell, routes, providers, flags, theme store, core-client
  screens/
    chat/             Tier-A chat/task threads
    goal/             Tier-A goal lenses + artifact review
    material/         Tier-A live Plane 1 Material, Thread binding, delivery, and proposal-comparison surfaces
    artifacts/        Tier-A Artifact inventory, exact content, import, and Thread introduction
    operations/       Tier-A recovery, scheduler admission, and global application search
    portability/      Tier-A User Settings import plus project-Workspace export, portable `.openkit-workspace.tar.zst` download/upload, and Vault rebind
    workspace-sync/   Tier-A Workspace change review, apply evidence, and recovery decisions
    workspace/        Tier-A Overview, Agents, Knowledge, First-run, Repositories, ArchivedThreadsScreen, New workspace
    settings/         Tier-A General, Administration, Configuration, AI interface, My admin access, Access tokens, Server audit, Deployment backup, Vault backend, Debug, Vault, Usage & audit
    demos/            Unpublished Tier-B review screens — Automations and Channels
    generative/       Unpublished Tier-C A2UI render shell + three-state fallback
  primitives/         React Aria + Spectrum-tokened primitive tier
  styles/
    tokens.css        token bridge — Spectrum-derived semantic tokens × 3 themes
    theme.css         Tailwind v4 @theme mapping + base layer
  test/
    setup.ts          jest-dom matchers
    tokens.test.ts    token-bridge parity anchor
e2e/                  L4 Playwright smoke + isolated stack helpers
playwright.config.ts
```

Portability downloads a created project-Workspace export through a same-origin `GET /api/app/workspaces/:workspaceId/exports/:exportId/archive` text link with encoded path segments and a new-tab indication, so native response errors do not replace the Portability page. Local archive import uses dry-run preview, then an explicit apply; archive bytes travel as `File` / `Blob` / `ReadableStream` through the existing Core Client session, never as base64 or a server filesystem path. A selected archive hides server-export handles until Use server export clears the file input; a different File invalidates the prior dry-run before import. A completed import announces Imported status with the workspace name and imported id, offers Open workspace through the existing switcher and Overview navigation, inserts the returned workspace into discovery before refetch, and keeps Review import and Import workspace disabled until the source File or handles change. The signed-in Better Auth session is unchanged.

## Status

The current React baseline includes the app shell, three-theme token bridge, sidebar-triggered global application search, one persistent selected-Workspace switcher, one active Conversations list with New conversation below it, archived Thread recovery, the Settings Debug component gallery and inspection panels, the deployment-admin Administration private conversation and retained-environment inspection and deletion controls, the deployment-admin Configuration file tree and JSONC editor, the deployment-admin AI interface for subscription accounts, provider profiles, API keys, and core and gateway defaults, live Chat, Task, Goal, Overview, selected-Workspace Agents, Knowledge, Artifacts, Recovery, Portability, Workspace changes, Repositories, Workspace Vault and Usage & audit, the bounded live Plane 1 Material surface, and internal unpublished Automations, Channels, and Generative UI review implementations. The Material surface includes identity, editing, immutable-revision history and comparison; one singular Thread binding with inclusion and queue state; active-turn exact-revision delivery and terminal outcomes; and version-keyed Artifact Review proposal, base, and current comparison with conflict-safe decisions and historical decision evidence. The Claude Design board inventory is a non-exhaustive visual reference, not evidence that every product surface is implemented.

Chat and Task Thread streams render every non-secret user-input Gate as accessible inline text or option controls and submit one complete answer map through the existing Core Client Turn command. Pending submission is disabled, a failed command retains its exact map for retry, and secret-bearing, connection-checking, or disconnected Gates remain visible without a submit action. An approval request remains legible after an approval decision with the same Turn and approval id appears, while its Approve and Deny controls are no longer rendered. The isolated Playwright stack can restart only NanoCore on its existing port and data root while keeping the Web process live, and its final stop still owns complete process and temporary-root cleanup.

Board 19 is live as a Tier-A selected-Workspace repository resources, diagnostics, default-repository setup, durable push records, and approval-gated push projection. The old Repositories demo, fixture, and export are absent. Existing Core Client and NanoCore contracts remain the owners; this Web package adds no API or external-effect owner. Workspace Sync review-to-apply and recovery evidence are live on the separate Workspace changes surface; no real external-push proof is claimed here.

The current account boundary uses `client.app.listAuthorizedWorkspaces()` for admission, opens the account gate only for the exact typed `401 core.auth.unauthenticated`, offers the existing email/password sign-up and sign-in operations, and exposes sign-out on the authenticated Account route; focused tests and the isolated server-mode browser journey cover this boundary, while real-use proof remains pending.

Selected-Workspace owner member administration, owner-issued invitation administration, the membership-independent account-level My invitations direct read with pending accept and decline decisions plus terminal rows, and selected active non-owner self-leave are focused-test-backed implementations through the existing Account route and the isolated server-mode browser journey; real-use and program-exit proof remain pending. Personal Quick Chat keeps its owner role display but exposes no sharing-management reads or controls. The ordinary-user operation guard covers all 141 included operations; only Automation CRUD and Knowledge proposal draft/reversal remain deliberately unpublished under R092, R070, and R072. The stack specification remains `Partial` because the Spectrum token package is still absent even though official A2UI v0.9 renderer packages are pinned for Chat Item rendering. Follow the current design→code loop in [`docs/cookbooks/claude-design-web-ui-loop.md`](../../docs/cookbooks/claude-design-web-ui-loop.md).

Theme selection applies to the document root, so account pages, native selects, and React Aria portals share the selected semantic tokens and color scheme. Existing tabs rehydrate theme changes from browser storage. The Workspace switcher persists an explicit authorized selection in `openkit-workspace`, scoped to the signed-in identity's Quick Chat Workspace, and restores it after reload only when that Workspace remains authorized; account transitions clear it. Composer model and draft stay unpersisted. The sign-in form also offers the three themes and fills the viewport. `/login` uses the same account boundary as other routes and redirects admitted users to Overview. Composer attachments use a React Aria popover dialog with Escape, outside-interaction dismissal, and focus restoration.

The Composer Agent selector shows target descriptions and availability reasons through React Aria label and description slots. Existing Worker choices belong only to the current conversation and are labeled accordingly; the server excludes other Threads and terminal history, and does not claim that a retained Worker is a running Sandbox. The starter offers no existing Worker continuation.

## Related docs

- Canonical design guide — [`DESIGN.md`](../../DESIGN.md)
- Web stack + token-bridge contract — [`docs/specs/20260710-web_ui_rebuild_stack.md`](../../docs/specs/20260710-web_ui_rebuild_stack.md)
- Product-surface projection — [`docs/specs/20260628-web_product_surface_projection.md`](../../docs/specs/20260628-web_product_surface_projection.md)
- Client boundary — `@openkit/core-client`

Conversation approval requests retain their resolved outcome beside the original request. Unavailable controls explain their state; pending decisions disable repeat submission, and failed decisions retry the same request identity.

Chat and Task headers show a failed latest Turn and its recorded error from the existing dashboard projection after a reload. An earlier accepted status Item remains history; displaying the failure never resubmits work.

Chat and Task Artifact references share an on-demand View content dialog in the stream and side panel. It uses the existing exact Artifact read, requires the message version to match, and renders recorded workspace-change paths and patch bytes with a full-content disclosure. Failed reads expose retry; inspection never applies or decides changes.

Approval decision cards show the recorded user display name or system actor, matching request, reason where the system operation establishes it, time and source. Recovery denials explicitly label inherited timestamps and missing recovery time; human client and reason fields remain unrecorded rather than inferred. Record identifiers stay in a disclosure.

The conversation side panel reuses the stream Item renderer so saved outputs and file-change records keep the same type labels, version or change kind, full wrapped names, and inspection actions. Its list scrolls vertically; Artifact subtypes are shown after loading the referenced content rather than inferred from a title.

The Thread layout uses a CSS container query: the conversation retains a 32rem minimum and the 15rem auxiliary panel docks only from a 47rem container width. Below that width the panel overlays the conversation without shrinking the composer. Close inside the non-modal panel restores focus to its header toggle. No viewport listener or duplicate panel tree is needed.

Base typography in styles/theme.css lets unspaced text and IDs wrap anywhere when needed, including narrative and pre-wrapped JSON. Explicit code/editor whitespace and local table scrolling remain intact. Context chips and menu triggers bound compact labels without losing full accessible names; menu choices wrap inside a bounded popover. Browser box measurements at the supported viewport floor are the deciding layout check rather than JSDOM class assertions.

Artifacts lists only the server-projected deliverable catalog, with a wrapping full title, kind and version. Search results and inventory selections preserve Workspace and Artifact identity in the URL, opening the existing exact-content preview after reload. Missing or unauthorized targets never select another output. Internal file-change reviews remain in Workspace Changes. `Add to conversation` means the existing exact-version imported-file reference command: it records a reference in an idle conversation and starts no Agent work. Produced outputs remain ineligible, with an explanation directing further work to composer attachments.

The primary sidebar keeps its 264px outer width without horizontal scrolling. Workspace destination controls form a four-column grid, and the Search popover stays within the sidebar content width.

Overview routes Workspace Review and synchronization recovery attention rows to Workspace changes even when they have no Thread. Decisions remain on the existing review surface, where users can inspect the changed paths and evidence first.

The Conversations sidebar reads actor-authorized navigation from NanoCore, showing current/latest activity icons and blue working or yellow actionable dots with text descriptions. Active rows precede idle rows and use server-derived conversation recency. The starter's Recent list reuses the same authorized order and opens the corresponding Chat, Task, or Goal route. Foreground polling and lifecycle invalidation refresh the projection; failures hide status dots and expose stale/unavailable state with Retry. Historical unknown activity remains explicit.

Account groups the current Workspace name, id, role and non-owner leave action in one card. My invitations prefers names from the existing authorized-Workspace admission cache, keeps ids secondary, and uses an explicit id fallback for Workspaces outside that authorized collection without adding a metadata lookup.

Overview combines current Action Center attention with every ongoing Task and Goal from authorized conversation navigation. It retains waiting times and direct approval Allow/Deny controls, keeps Goal and Workspace reviews in context, refreshes activity after decisions, and replays uncertain requests with the same identity. Decision errors and retry controls remain bound to their originating Workspace.

The bottom sidebar uses one Settings gear button that opens Account directly. The shared Settings navigation includes Workspace / General at `/workspace` alongside User, Server, and Administration, without an intermediate settings-choice menu or a second sidebar. General appears only for a validated Workspace and follows the sole Workspace switcher; Settings remains reachable without a selection.

Failed Turns retain their recorded dashboard errors in conversation history after later Turns finish, including failures with no Items. Interleaved Items keep their log order; each historical error appears once after that Turn’s last Item group. Latest failures remain in the header and do not offer an automatic retry.

Agents reads selected-Workspace current Workers through `client.app.listWorkspaceWorkers` above the separately labeled configured catalog. Worker rows are keyed by Thread and show recorded state, a Last recorded timestamp that is persisted status rather than live liveness, the exact known current Goal/Task assignment, and the existing Task conversation link. Row `stale` is labeled Setup outdated for setup-generation continuity and is not combined with disconnected fetch freshness, which stays on Worker read may be stale. Package preference, last-used model (restricted or unavailable when the server says so), selected MCP/tool policy, and bounded policy counts stay behind native details. Unknown or null policy default/enforcement labels are Not reported; a wholly absent filesystem, network, or process dimension is Not recorded. Refresh workers refetches that read without catalog health refresh. A stale or failed Worker read never becomes an empty success, and an absent selected Workspace is not shown as an empty Worker inventory. Catalog entries with no authored role display Worker, including unknown or unavailable supply; runtime names never imply Coding or another role. Catalog presence alone does not make an Agent ready or running.
