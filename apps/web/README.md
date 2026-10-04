# @openkit/web

The OpenKit Web UI is a React SPA that projects stable NanoCore / App API contracts as a supervisor's workbench. This is the rebuilt app; the previous SolidJS + daisyUI implementation is retired and is not a current reference tree.

This guide owns the package's local purpose, boundaries, commands, and workflow.

## Boundaries

The Web UI is a product surface over NanoCore and App API contracts, and it consumes the server only through the composed `@openkit/core-client` sub-clients. Its shared schema and client imports must remain browser-safe through every transitive package export; the complete `@openkit/config-schema` root includes Node-only modules and cannot enter this graph.

[`docs/specs/20260628-web_product_surface_projection.md`](../../docs/specs/20260628-web_product_surface_projection.md) owns that posture, ordinary-user inclusion and dispositions, and the current implementation projection. [`docs/specs/20260710-web_ui_rebuild_stack.md`](../../docs/specs/20260710-web_ui_rebuild_stack.md) owns the implementation stack, the token bridge, the separation of server state and UI state, and the shared Composer component boundary.

[`DESIGN.md`](../../DESIGN.md) owns:

- information architecture
- the three themes
- component grammar
- responsive behavior
- accessibility
- the weak-interaction model

[`docs/specs/20260831-unified_conversation_composer.md`](../../docs/specs/20260831-unified_conversation_composer.md) owns the shared Composer interaction contract. Local agent execution rules are in [`AGENTS.md`](./AGENTS.md).

The Behavior owners section names the owning section for screen behavior that lives in an accepted specification or in `DESIGN.md`. Implementation notes hold behavior those sections do not state.

## Stack

[`docs/specs/20260710-web_ui_rebuild_stack.md`](../../docs/specs/20260710-web_ui_rebuild_stack.md) (Decision) owns the rebuilt stack:

- React on Vite
- Zustand for UI state
- TanStack Query for server state over `@openkit/core-client`
- React Router
- Tailwind CSS v4
- React Aria Components
- Adobe Spectrum as the token source
- A2UI for generative UI
- Iconify with Remix Icon

The package was scaffolded with the official `create-vite` `react-ts` template.

Biome lints and formats this package with the repo-wide config. Vitest and Testing Library run the unit tests. Playwright runs the end-to-end tests.

Scanner-only JSONC highlighting and the assistant-report Markdown parser are under Implementation notes, Package checks and code placement.

[`docs/specs/20260710-web_ui_rebuild_stack.md`](../../docs/specs/20260710-web_ui_rebuild_stack.md) (Current Implementation Projection and Stack-Conformance Backlog) owns the pinned A2UI packages and the hand-maintained token bridge. The stack specification stays `Partial` for the reason in that backlog.

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

The built-package regression in `test/browser-package-boundary.test.ts` follows the browser-resolved import graph of the shipped App API schema, Core Client, and protocol entries. Build `packages/*` before running it; it rejects Node built-ins and Node globals, including delayed schema refinements. This check does not require a live NanoCore or a browser process.

The package `test` command remains the full-suite command. Adding `-- <file>` to it has been observed to run the full suite, so do not use that form as focused evidence.

`e2e` expects a built NanoCore (`pnpm --filter @openkit/nanocore build`). Specs start an isolated stack on dynamic ports via `e2e/_lib/servers.ts` and set `VITE_CORE_BASE_URL` so the SPA talks to that Core. Run the self-contained root gate with `pnpm -w test:e2e:web`; it builds NanoCore before invoking the Web `e2e` command.

Run alongside NanoCore for the product loop:

```bash
pnpm --filter @openkit/nanocore dev   # start the core first
pnpm --filter @openkit/web dev        # then the SPA
```

What the isolated simulator stack and the viewport self-checks prove is under Implementation notes, Package checks.

## Structure

```
src/
  main.tsx      app entry
  app/          shell, routes, providers, flags, theme store, and Core Client wiring
  screens/      product screens, one directory per product area
  generative/   A2UI component catalog for generative Chat Items
  primitives/   React Aria and Spectrum-tokened primitives
  styles/       design tokens and Tailwind theme mapping
  test/         Vitest setup and token parity test
test/           Node-environment checks of browser-reachable built packages
e2e/            L4 Playwright smoke and isolated stack helpers
```

## Status

[`docs/specs/20260628-web_product_surface_projection.md`](../../docs/specs/20260628-web_product_surface_projection.md) (Current Implementation Projection) and [`docs/specs/20260710-web_ui_rebuild_stack.md`](../../docs/specs/20260710-web_ui_rebuild_stack.md) (Current Implementation Projection) own the current package status. [`DESIGN.md`](../../DESIGN.md) (§11 and §9.14) owns publication tiers and the rule that the Claude Design board inventory is a non-exhaustive visual reference. [`docs/specs/20260628-web_product_surface_projection.md`](../../docs/specs/20260628-web_product_surface_projection.md) (Current Implementation Projection) owns member administration, invitations, self-leave, and their pending real-use proof. Status sentences those projections do not state are under Implementation notes, Status inventory.

Follow the current design-to-code loop in [`docs/cookbooks/claude-design-web-ui-loop.md`](../../docs/cookbooks/claude-design-web-ui-loop.md).

## Related documents

- Canonical design guide — [`DESIGN.md`](../../DESIGN.md)
- Web stack and token-bridge contract — [`docs/specs/20260710-web_ui_rebuild_stack.md`](../../docs/specs/20260710-web_ui_rebuild_stack.md)
- Product-surface projection — [`docs/specs/20260628-web_product_surface_projection.md`](../../docs/specs/20260628-web_product_surface_projection.md)
- Unified conversation Composer — [`docs/specs/20260831-unified_conversation_composer.md`](../../docs/specs/20260831-unified_conversation_composer.md)
- Client boundary — [`docs/specs/20260528-core_client_boundary.md`](../../docs/specs/20260528-core_client_boundary.md)
- Design-to-code loop — [`docs/cookbooks/claude-design-web-ui-loop.md`](../../docs/cookbooks/claude-design-web-ui-loop.md)
- Local agent rules — [`AGENTS.md`](./AGENTS.md)

## Behavior owners

`docs/specs/20260704-task_mode_worker_delegation.md` (Readable initiating request projection) owns task request summaries in the conversation stream.

`docs/specs/20260715-multi_user_workspace_system.md` (Conversation Author Projection) owns participant names, You alignment, avatars, and account-transition cache removal. `DESIGN.md` (§9.1) owns the message shapes.

`docs/specs/20260628-web_product_surface_projection.md` owns these topics in Truthful unpublished capability, Deployment Configuration Projection, Unified Gateway Settings Projection, Authority and projection boundary, Repositories Projection Contract, Account Gate And My Invitations Projection, and Runtime Activity In The Thread Timeline:

- deployment-admin session authority
- Configuration file and reload behavior
- Gateway deployment-admin authorization
- Generative UI publication
- Agents worker rows
- archived Threads
- the sole Workspace switcher
- conversation-navigation ordering
- the Repositories contract
- the account gate
- Thread runtime activity

`docs/specs/20260721-provider_subscription_accounts.md` (Web And Skill Observation Semantics) owns Gateway account quota, billing, refresh, and time display.

`docs/specs/20260831-unified_conversation_composer.md` (Composer Interaction Contract, Advanced Worker Environment Choice, and Target Catalog) owns Composer layout, keyboard behavior, the advanced Worker environment choice, and per-Thread Worker targets.

`docs/specs/20261002-goal.md` owns the current Goal journey, which uses the definition-derived Goal operations for intent, cards, exact Plan decisions, Task links and cancellation.

`DESIGN.md` (§9.5) owns the Draft › Plan › Execute › Review strip.

`DESIGN.md` (§3.1, §3.2, §3.3, §9.4, §12, and §13) owns:

- sidebar width
- shortcut grid
- Settings navigation
- header glyph size
- Side panel docking
- conversation hint shape
- base wrapping
- modal focus restoration

`DESIGN.md` (§11) owns the rule that surfaces ahead of a stable kernel contract stay out of published navigation and routing.

`DESIGN.md` (§9.9) owns Artifact View content inspection.

`docs/specs/20260704-vault_backend_implementation.md` (Public Workspace Secret Administration) owns Vault secret fields, mutation-response discarding, and cache exclusion.

`docs/specs/20260628-web_product_surface_projection.md` (Current Implementation Projection) owns the ordinary Workspace Vault reads and the exclusion of deployment-admin backend status from that screen and from Portability.

`docs/specs/20260711-skill_catalog_versioning_pinning.md` (Current Implementation Projection) owns catalog import, pin, and selection, and the choice not to advertise native plugin loading.

`docs/specs/20260907-mcp_catalog_management.md` (Current Implementation Projection) owns stdio MCP enablement authority.

`docs/specs/20260910-app_update_delivery.md` owns the administrator App update screen.

`docs/specs/20260709-quick_chat_workspace.md` owns Quick Chat sharing rejection.

`docs/specs/20260710-web_ui_rebuild_stack.md` (Unified Composer component boundary) owns the rule that Composer draft and logical-model selection do not survive reload.

## Implementation notes

These notes are current implementation details that the owning specifications do not state, while the owners linked under Behavior owners decide behavior.

### Conversation stream

The conversation stream uses the authorized dashboard taskInputs summaries for verified Worker request objectives. View request details retains the exact original message; absent summaries and ordinary human JSON remain verbatim. The existing Pending Request system actor's frozen outcome input is a retained S39 trace source and is omitted from the conversation; the answer or decision remains visible through its S59 Item.

### Status chips and Goal attention

Status chips retain their full single-line label under flex pressure; surrounding descriptions wrap instead. Goal attention explanations appear as full body text below the short status label.

### Turn header and conversation refresh

Conversation messages and the active Turn header resolve authorized participant names from the Thread dashboard by exact actor kind and id; the header marks the current human as You and retains recorded ids when a name is unavailable.

An open Chat or Task Thread refreshes its existing dashboard observer every 5s in the foreground, including during execution so newly verified request summaries become visible. Its item observer polls only while idle, so another client's completed Chat turns appear without reload even when dashboard and items arrive in different orders; a running Turn keeps SSE as the sole live Item writer. Administration does not opt into this poll, and other Threads or Workspaces are not refreshed.

### Gateway

The deployment-admin Gateway destination at `/settings/ai-interface` presents Providers, Models, and Logical models from active redacted diagnostics. Each Provider card composes the active profile with its exact subscription account slot or submit-only API-key entry. Retained unbound Codex and xAI slots remain reachable with create, display-name update, device login, cancel, quota refresh, Log out, and Remove controls. Log out and Remove remain reachable during pending login and with logical references; each bound card lists the affected logical models, including when its slot is absent or unavailable after deletion. Profile deletion locates the exact authored source and uses its read revision through `operations['runtime.file-delete']`; subscription slot deletion remains a separate operation and routes are never rewritten or promoted.

Guided subscription setup sequences retained-slot selection or slot creation, bound-profile creation, device login, and a separate login-status observation. Once admitted, its transient setup owner stays mounted through dependency loading, failure and denial; it keeps completed steps and the persisted profile revision visible, gates actions until dependencies recover, retries the failed dependency only, and reports profile activation as restart-required. Each dependency has visible typed denial or fixed failure copy and an explicit retry; no Token-entry fallback or cross-owner rollback is added.

Models show effective context, output, input/output modalities, reasoning and canonical effort levels, and known pricing with per-leaf upstream snapshot, deployment extension, or profile override provenance. Unknown values, false, zero and explicit empty arrays remain distinct. The exact-key extension editor preserves surrounding JSONC comments and uses server validation and the read file revision. Logical models keep primary and ordered backups, failover, partial coherent capabilities, and each route's network-free availability reason visible. Their route editor preserves authored order and uses the same validation, CAS, and explicit reload workflow. File persistence, reload application, and pending restart are shown separately; active metadata remains authoritative until restart. Provider and server-default source editing remains available in the separate Configuration destination.

Account quota windows retain supplied periods and exact reset times with inspectable browser-local instants; each window shows remaining percentage once, or used percentage when remaining is absent. Unknown billing values remain unknown and zero remains zero. Temporary quota failures clear current amounts and meters and offer account-scoped refresh. A saved login without an available quota observation is labeled Login saved unless access rejection is known; exact authentication rejection offers Sign in again and explains that the login may remain refreshable. xAI costs fetch auto-top-up only on disclosure expansion or explicit refresh while expanded. Quota reads have no background poll or durable cache. Subscription cards show account-owned inference rejection and quota-exhaustion observations with their own timestamps and the existing Sign in again and Refresh quota actions, alongside the unchanged live quota response. Account list and detail reads carry these observations; rendering or refreshing them adds no quota request.

### General settings and Configuration

General Workspace settings share the Settings shell under Workspace, read only the selected Workspace, offer display-name editing and a Knowledge entry, and never request deployment diagnostics or runtime config.

Configuration keeps a collapsible, keyboard-navigable relative-path file tree beside the editor on wider screens and above it on narrow screens. **Hide files** expands the editor workspace without losing the current draft or folder expansion state; the full selected path stays visible in the editor heading. Everyday configuration is directed to NanoCore’s **Server Operation Agent** in Administration (`administration.conversation-submit`) with user-granted permissions; the generic file editor remains available for inspection and careful manual edits. The apply result displays any server-returned safe-reload warnings beside the reload outcome. Its **Show schema** control reads `client.operations['runtime.schemas']()` on demand and displays the selected file kind's server-owned JSON Schema in a scrollable reference. Schema failures offer explicit retry while preserving the configuration draft; an absent kind is shown as unavailable.

### Administration

The product-surface specification leaves the broader deployment-admin Web surface with roadmap R048.

The Tier-A Settings **Administration** screen uses the same session-derived deployment-admin authority without accepting Token plaintext. Its private administration conversation is a distinct Thread entry in the current User's Quick Chat Workspace and continues only through the dedicated administration conversation endpoint. Catalog configuration candidates are discovered from the same authorized private Thread Artifact references as environment candidates, bound to exact Artifact version and content digest, and shown with target provider or gateway identity, before/after editable metadata, base revision, and restart impact. Application is never model-applied: the administrator uses **Review configuration** then **Apply configuration** through `client.operations['administration.configuration-apply']` with payload-bound confirmation. A recorded apply outcome Artifact for that exact candidate is shown as persistence, reload, and restart separately; unknown or failed application disables Apply rather than repeating the command. Environment preparation reads an actual published Server Agent manifest and its exact configuration SHA, then keeps authored and resolved candidates in that private Thread. Result-only recovery uses the exact authored Artifact; human activation reuses the response's payload-bound confirmation and shows the shared Agent's later-admission scope, optional exact current Thread and successor prompt, configuration result, and each retained environment disposition. The globally selected Workspace separately scopes immediate-replacement Thread selection, the retained Worker environment list, current host status, and explicit whole-environment deletion. Environment inspection labels the returned Core association state and revision separately from host storage state and attachment; host availability alone does not establish reuse eligibility. Deletion is bound to the displayed environment revision, and an unknown host result requires a fresh status inspection before another effect request. The exact private candidate also determines a stable application request ID, so a fresh render cannot turn an uncertain command into a new write request.

### Vault

The accepted ordinary Workspace Vault placement is read-only and uses exactly `client.operations['vault.reference-list']`, `client.operations['vault.grant-list']`, `client.operations['vault.injection-plan-list']`, `client.operations['vault.injection-receipt-list']`, and `client.operations['vault.use-list']` for the selected Workspace. It does not request or project deployment-admin backend status.

The separate Tier-A Settings Administration **Vault backend** surface at `/settings/vault-admin` uses `client.operations['vault.status'](input)`, `client.operations['vault.unlock']({ masterKeyBase64 })`, and `client.operations['vault.lock'](input)` with session-derived deployment-admin authority. It projects backend kind, state, and redacted diagnostic. When unlocked, its selected-Workspace secret panel lists redacted references and grants, accepts new or replacement material through a password field, creates gateway-only MCP and separate runtime-env grants, and revokes secrets or grants. Secret fields clear on submission and Workspace changes; mutation responses are discarded and only whitelisted inventory is cached. Unlock accepts an existing base64 master key through a password field cleared on submission; key material never enters query or mutation caches, browser storage, URLs, or errors. Lock and unlock require explicit actions and refresh status on success. Pending requests block overlapping actions and key edits; denial hides status, and Retry rechecks status without replaying a mutation. The permission and multi-user Workspace specifications own that authority separation.

### Usage and audit

The live Tier-A board-17 **Usage & audit** screen is implemented as a read-only projection scoped to the selected Workspace. It uses exactly `client.operations['usage.read']`, `client.operations['audit.workspace-list']`, and `client.operations['permission.workspace-list']` with that validated Workspace, and it never calls or projects `client.operations['audit.server-list']`. The separate Settings **Server audit** surface at `/settings/server-audit` reads `client.operations['audit.server-list'](input)` and `client.operations['permission.server-list'](input)` independently of Workspace selection. NanoCore derives deployment-admin authority from the current browser session; Web never requests Token plaintext and shows access denied with explicit retry. Both surfaces whitelist and redact display metadata before caching, omit private payloads, and remain read-only. Server audit does not claim complete deployment audit coverage.

Shared audit rows preserve the recorded event time (`occurredAt`, falling back to `createdAt`) and permission-decision creation time in their safe display projection. Server audit remains deployment-admin scoped; Usage & audit remains selected-Workspace scoped. Both show local date/time with its timezone and retain the exact ISO timestamp in semantic `time` markup; missing time is explicitly unavailable. Usage measurements additionally show their recorded time and logical-model attribution. Known Gateway input, output, cache-read, cache-write, total and estimated-cost sources receive distinct display labels; unknown sources retain a neutral label rather than an inferred metric. Measured rows precede a collapsed capability-call disclosure. Raw source strings, provider/runtime identifiers and payloads stay outside the display projection; no aggregate or billed-cost claim is derived from these rows.

### Workspace changes

The Repositories screen, route, navigation entry, and data hooks are removed. Workspace changes continues to project synchronization records and non-Git review/apply. Hosted publication uses selected vendor MCP through the Gateway.

Review cards prioritize changed paths, status, risk and change counts; exact record identifiers and full diffs remain available through native disclosures. Low-level synchronization inventories stay under diagnostics, while apply results and recovery decisions remain visible.

### Catalog

The live Tier-A **Catalog** screen projects selected-Workspace Skill, MCP, and Agent Plugin catalog management through `client.operations`. It imports SKILL.md files or Skill folders, pins current Skill versions, creates inactive MCP configurations, toggles enablement, and imports plugin.json packages. Fresh Skill and MCP fields keep actual values empty and show examples only as native placeholders; Skill file and folder import stay disabled until a display name is entered. Directory uploads snapshot selected files before resetting the native input, so the live FileList cannot disappear during submission. Browser File API folder uploads include regular files only and cannot preserve executable flags or empty directories. Writes stay disabled while disconnected.

### Generative UI

The live Chat surface renders `generative-ui-reference` Thread Items through the eight native A2UI types mapped onto OpenKit primitives.

### Debug

The Settings **Debug** surface contains the component catalog and is the single Web placement for future developer-facing inspection panels after their contracts and authorization are accepted.

### Shared modals

Shared Modal surfaces stay within the padded viewport and scroll long content so confirmation controls remain reachable. React Aria continues to own focus containment, Escape dismissal and focus restoration.

### Deployment backup

Settings **Deployment backup** at `/settings/data-root-backup` creates and verifies deployment data-root backups through `client.operations['backup.create']({})` and `client.operations['backup.verify']({ backupId })`, independently of Workspace selection. It uses session-derived deployment-admin authority with access-denied retry and no Token plaintext. Creation is explicit; verification accepts the returned ID or a known ID. Summaries whitelist the backup ID, mode, consistency, start/completion timestamps, file count, total bytes, and checked-file count; inventory paths and raw errors are omitted. Retry never automatically repeats creation.

### Workspace access recovery and disable user

Settings Administration **Workspace access recovery** at `/settings/workspace-access-recovery` explicitly loads `client.operations['workspace.access-recovery-read']({ workspaceId })` and submits `client.operations['workspace.access-recover']({ workspaceId, ...input })` with a new request ID and the loaded registry revision. It shows only workspace ID, owner user ID, administrator role, and registry revision; transfer-to-self requires typing the workspace ID. **Disable user** at `/settings/disable-user` starts with no target and requires matching typed user ID confirmation before `client.operations['user.disable']({ targetUserId: userId, ...input })`. Its summary contains only user ID, disabled status, and disabled timestamp. Both surfaces use the signed-in session’s derived deployment-admin authority with no Token plaintext; denial hides results and Retry probes access again. Mutation errors never automatically replay actions, and recovery failures require a fresh state load.

### App update

Settings **App update** projects deployment-admin `app-update.prepare`, `app-update.start` and `app-update.status` through `client.operations`. It is scoped to the deployment, independent of the selected Workspace. The administrator reviews an immutable prepared source and explicitly consents to maintenance; the host receipt owns the result across App restarts. The deployed host helper must be configured before this surface can perform an update.

### Composer

New Chat opens its accepted originating Thread as soon as Thread creation completes, while the synchronous first `conversation.submit` remains pending. Thread progress and Stop follow the authoritative dashboard. The existing submission mutation cache carries the full draft and request identity across this route transition; pending submission blocks duplicate Send, failure retains that same request for explicit retry without creating another Thread, and success clears sent text, attachments, and Worker environment choice and creates a fresh request identity. The chosen agent and logical model remain selected for the next message. A route-local request marker permits the eventual receiving-Thread handoff only while the user is still viewing the submitting conversation; switching conversations or Workspaces cannot be overridden by a late completion. Drafts remain in memory and do not survive reload.

Chat and Task Composer target availability follows changes to the current Thread's latest observed Turn identity or status, including SSE completion and the existing foreground dashboard refresh. Only that Thread's target catalog is refreshed; NanoCore still decides whether a Worker is available.

The existing `+` chooser exposes Advanced settings for new Task Worker work: default new environment or explicit retained-environment reuse, with readable source provenance, labeled local creation time to distinguish same-source environments, and eligibility. Selection previews use the existing administrator-scoped environment reads; structured submission forwards the exact choice for send-time revalidation by actual receiving-Thread admission, preserving idempotent replay after transport uncertainty; errors retain the draft and choice rather than silently creating fresh storage.

The Composer Agent selector shows target descriptions and availability reasons through React Aria label and description slots.

The Composer's lower row includes a React Aria reasoning-effort selector only when the selected logical model advertises reasoning levels. Options follow the canonical effort order. Active Threads preselect the latest recorded admitted Turn effort only while that model advertises it; starter conversations have no Thread preselection. The existing structured submission forwards explicit effort and preserves both effort and omission with the full draft and request identity after failure or transport uncertainty, even when the catalog or dashboard refreshes. An effort removed from current advertisements remains explained in the retained retry draft.

An Assistant submission returning the typed `499 provider_call_aborted` confirms that its admitted Turn was interrupted. The Composer retains the full draft and explains that the next explicit Send starts a new Turn. That Send mints and stores a fresh request identity before dispatch; if the new attempt then has transport uncertainty, its retry reuses that new identity and the same draft, including target, model, Artifacts, and Worker environment choice. Other failures keep their existing exact-retry behavior. A local abort, a Stop click, or an untyped error is not cancellation proof, and this path never automatically resubmits or clears the draft.

### Goal

Goal uses one server-backed journey through `client.operations`: create with an optional origin Thread, revise intent, create or edit and cancel cards, inspect separate proposed and active immutable Plan versions, decide the exact shared Plan or completion request, read linked ordinary Tasks, and cancel the Goal. The view displays exact commitment bytes and digest and current request claim state. A completed Task leaves the Goal open. UI drafts remain local, while TanStack Query owns the joined server view; explicit retries retain the original command payload and request identity. Connection uncertainty, pending mutations and closed Goals disable writes.

### Thread chrome and side panel

Thread header icon commands use 20px glyphs in 32px square buttons without inherited horizontal padding. Shared icons retain their declared width inside flex layouts and inherit the active theme foreground. Task thread headers show the sidebar Worker-task glyph at 20px in a nonshrinking titled span labeled Task.

The Thread Side panel indexes each referenced Artifact version once, even when multiple Turns attach it. Conversation history retains every reference, and file-change records remain individually visible. The Thread layout uses a CSS container query: the conversation retains a 32rem minimum and the 15rem auxiliary panel docks only from a 47rem container width. No viewport listener or duplicate panel tree is needed. The conversation side panel reuses the stream Item renderer so saved outputs and file-change records keep the same type labels, version or change kind, full wrapped names, and inspection actions. Its list scrolls vertically; Artifact subtypes are shown after loading the referenced content rather than inferred from a title.

### Primitives and lenses

Primitive status pairs are owned by `src/primitives/status.ts`; CountBadge and PhaseStepper reuse those pairs while retaining their distinct accent and foreground-only states. Workspace Overview uses its live attention and conversation queries, and Portability hooks infer result shapes from the Core Client.

### Thread runtime activity

Existing Item-backed approval, input and correction controls remain the interaction owners; account transitions clear activity through the same dashboard cache.

### Portability

The product-surface Current Implementation Projection states project-Workspace rebind with ephemeral credential handling.

Portability downloads a created project-Workspace export through a same-origin `GET /api/app/workspaces/:workspaceId/exports/:exportId/archive` text link with encoded path segments and a new-tab indication, so native response errors do not replace the Portability page. Local archive import uses dry-run preview, then an explicit apply; archive bytes travel as `File` / `Blob` / `ReadableStream` through the existing Core Client session, never as base64 or a server filesystem path. A selected archive hides server-export handles until Use server export clears the file input; a different File invalidates the prior dry-run before import. A completed import announces Imported status with the workspace name and imported id, offers Open workspace through the existing switcher and Overview navigation, inserts the returned workspace into discovery before refetch, and keeps Review import and Import workspace disabled until the source File or handles change. The signed-in Better Auth session is unchanged.

### Package checks and code placement

`src/test/setup.ts` gives Testing Library's asynchronous queries and `waitFor` a shared 3000 ms bound for scheduling contention during parallel package tests. These unit waits prove eventual UI state, not a product render-time budget; measured initial Knowledge controls appear in about 100–205 ms alone and within 2s under CPU contention. Explicit per-wait bounds and Vitest's 10000 ms case limit remain in force.

The Chat stale-refetch regression queries and asserts completed Markdown content in one `waitFor` callback, because stream-drop rendering can replace a previously found DOM node while keeping the same message visible. It still checks exact content, one retained completed item after the stale response settles, and unchanged read/subscription counts.

Knowledge unit journeys paste complete draft values through user-event into focused fields, retaining accessible selection, submission, retry and authoritative-refetch assertions without replaying unrelated keystrokes. The long ledger and cross-Workspace draft cases check Vitest's abort signal at user-event waits; the cross-Workspace case also checks it before changing the shared Workspace store, so timed-out input cannot continue into a following case.

The Material handoff self-check proves revision delivery through the verified worker-seen projection after the simulator completes its question-raising Turn; it checks that the current-turn field is unavailable after that terminal proof. The browser-free `e2e/_lib/servers.spec.ts` regression drives the same warm-Worker `conversation.submit` path, observes terminal SSE, checks the exact Context Package revision and digest, and preserves a distinct next revision queue across Core restart. It also verifies one durable, decidable Pending Request survives that restart, answers through the real Core Client operation, observes terminal SSE on a distinct later Turn of the same Task, and checks the answer Item, delivery association, and complete frozen input in that Turn's retained Agent Environment Package. It additionally verifies that the checkpoint-free answer Turn owns an accepted Context Package digest, consumes the exact queued Material revision, and preserves both projections across a second Core restart.

The Web fixture-cleanup regression injects a failure at a surviving provider-profile write and checks removal of both owned roots; process-cleanup probes read Core lock bytes after their Web-child readiness marker, preserving the PID and signal assertions without racing publication. The isolated Web fixture seeds the surviving Demo Workspace, membership, Agent and inference configuration without a host repository resource, following the accepted host repository retirement. Its authored Agent image receives explicit synthetic digest-bound empty defaults through the built `writeWorkerImageSettlement` and `admitWorkerImageEnvironment` seam used by the Worker MCP smoke; the browser-free restart regression checks production native-environment resolution before and after Core restart. This fixture evidence does not qualify a real image or install a production admission default. The isolated simulator-backed Web stack seeds a visibly synthetic local NanoHost Epoch after Core startup and after a Core restart in its disposable data root, matching the simulator unit-test precondition. Non-simulator stacks receive no synthetic readiness. Production backend-session validation stays enabled. These checks prove Web and Core interaction against the simulator; they do not prove real NanoHost readiness or Worker execution on a deployed server. The Material self-check exercises Artifact review and acceptance at 800×600 without page-level horizontal overflow. shell-smoke verifies Settings and Chat at 600 and 742 without page-level horizontal overflow, and persistent left navigation at 800. The isolated Playwright stack can restart only NanoCore on its existing port and data root while keeping the Web process live, and its final stop still owns complete process and temporary-root cleanup. Browser box measurements at the supported viewport floor are the deciding layout check rather than JSDOM class assertions.

Use `useConnection` in `src/app/core-client.tsx` for the shared `core.meta()` connection probe; General Settings reads its Workspace through `useSettingsWorkspace` in `src/screens/settings/data.ts`. Starter and Thread Composer uploads share `importComposerFile` in `src/screens/artifacts/data.ts` over the existing Artifact mutation; each screen retains its own non-awaited Artifact-list refresh after import. Sidebar, starter Recent, and Overview activity destinations share `conversationThreadPath` in `src/screens/chat/data.ts`, preserving encoded owner identifiers and unknown activity opening Chat; Sidebar active matching remains cross-mode and includes nested Thread routes.

**jsonc-parser** is scanner-only JSONC syntax highlighting for the native configuration textarea; NanoCore remains the parser and validator. **markdown-it** is the parser already supplied by A2UI, directly configured for readable assistant reports. Raw HTML is disabled, images remain escaped text, and only explicit HTTP(S) links are navigable. Human messages and raw evidence remain verbatim; the Web projection does not change API or Skill message text.

### Account, theme, and invitations

The current account boundary uses `client.operations['workspace.list']({})` for admission, opens the account gate only for the exact typed `401 core.auth.unauthenticated`, offers the existing email/password sign-up and sign-in operations, and exposes sign-out on the authenticated Account route; focused tests and the isolated server-mode browser journey cover this boundary, while real-use proof remains pending. Personal Quick Chat keeps its owner role display but exposes no sharing-management reads or controls.

Theme selection applies to the document root, so account pages, native selects, and React Aria portals share the selected semantic tokens and color scheme. Existing tabs rehydrate theme changes from browser storage. The Workspace switcher persists an explicit authorized selection in `openkit-workspace`, scoped to the signed-in identity's Quick Chat Workspace, and restores it after reload only when that Workspace remains authorized; account transitions clear it. The sign-in form also offers the three themes and fills the viewport. `/login` uses the same account boundary as other routes and redirects admitted users to Overview. Composer attachments use a React Aria popover dialog with Escape, outside-interaction dismissal, and focus restoration.

Account groups the current Workspace name, id, role and non-owner leave action in one card. My invitations prefers names from the existing authorized-Workspace admission cache, keeps ids secondary, and uses an explicit id fallback for Workspaces outside that authorized collection without adding a metadata lookup.

### Inclusion count

The ordinary-user inclusion count and roadmap dispositions are stated by `docs/specs/20260628-web_product_surface_projection.md` under Decision and Current Implementation Projection.

### Chat and Task outcomes

Chat and Task Thread streams render non-secret pending user-input requests as accessible inline text or option controls and submit one complete answer map through `client.operations['question.answer']`. Pending submission is disabled, and a failed command retains its exact map and request identity for retry. Secret-bearing, connection-checking, or disconnected requests remain visible without a submit action. An approval request remains actionable after its raising Turn ends; authoritative pending-request state closes its inline controls immediately when resolved, ended, or inspect-only. Later-Turn decisions and answers correlate to their original request by request identity.

Conversation approval requests retain their resolved outcome beside the original request. Unavailable controls explain their state; pending decisions disable repeat submission, and failed decisions retry the same request identity.

Chat and Task headers show a failed latest Turn and its recorded error from the existing dashboard projection after a reload. An earlier accepted status Item remains history; displaying the failure never resubmits work.

Approval decision cards show the recorded user display name or system actor, matching request, reason where the system operation establishes it, time and source. Recovery denials explicitly label inherited timestamps and missing recovery time; human client and reason fields remain unrecorded rather than inferred. Record identifiers stay in a disclosure.

Failed Turns retain their recorded dashboard errors in conversation history after later Turns finish, including failures with no Items. Interleaved Items keep their log order; each historical error appears once after that Turn’s last Item group. Latest failures remain in the header and do not offer an automatic retry.

### Knowledge retrieval

Every production Knowledge caller in `screens/workspace/data.ts` uses the definition-derived `client.operations` map with one Workspace-bound argument. The existing entry, Source, ledger, retrieval, manager and proposal-decision hooks retain their retry, request identity and Workspace-cache ownership.

Retrieval preserves the recorded trace identity and selected-hit order while composing titles and previews of at most 240 characters from the selected Workspace's existing authorized Knowledge read. These are explicitly labeled current content and may differ from the recorded retrieval; they are not a retrieval-time snapshot. Each available hit links to the existing full-content display. Missing entries and failed current reads show content as unavailable, including when a failed refetch retains cached data. Workspace changes hide results from another Workspace, and excluded hits retain only their existing reason labels without content enrichment.

### Artifacts and typography

Chat and Task Artifact references share an on-demand View content dialog in the stream and side panel. It uses the existing exact Artifact read, requires the message version to match, and renders recorded workspace-change paths and patch bytes with a full-content disclosure. Failed reads expose retry; inspection never applies or decides changes.

Context chips and menu triggers bound compact labels without losing full accessible names; menu choices wrap inside a bounded popover.

Artifacts lists only the server-projected deliverable catalog, with a wrapping full title, kind and version. Search results and inventory selections preserve Workspace and Artifact identity in the URL, opening the existing exact-content preview after reload. Missing or unauthorized targets never select another output. Internal file-change reviews remain in Workspace Changes. `Add to conversation` means the existing exact-version imported-file reference command: it records a reference in an idle conversation and starts no Agent work. Produced outputs remain ineligible, with an explanation directing further work to composer attachments.

### Conversations, Overview, and Agents

Conversation row hints open to the right with ordinary library viewport flipping, stay pointer-non-interactive so they never intercept the next row, clamp the visible title to three lines, and keep the description on separate wrapping lines inside a viewport-bounded overlay. The row button retains its full accessible name and description on hover and keyboard focus. The starter's Recent list reuses the same authorized order and opens the corresponding Chat, Task, or Goal route. Foreground polling and lifecycle invalidation refresh the projection; failures hide status dots and expose stale/unavailable state with Retry.

Overview routes Workspace Review and synchronization recovery attention rows to Workspace changes even when they have no Thread. Decisions remain on the existing review surface, where users can inspect the changed paths and evidence first. Overview combines current Action Center attention with every ongoing Task and Goal from authorized conversation navigation. It retains waiting times and direct approval Allow/Deny controls, keeps Goal and Workspace reviews in context, refreshes activity after decisions, and replays uncertain requests with the same identity. Decision errors and retry controls remain bound to their originating Workspace.

Agents reads selected-Workspace current Workers through `client.operations['worker.list']` above the separately labeled configured catalog. Worker rows are keyed by Thread and show recorded state, a Last recorded timestamp that is persisted status rather than live liveness, the exact known current Goal/Task assignment, and the existing Task conversation link. Row `stale` is labeled Setup outdated for setup-generation continuity and is not combined with disconnected fetch freshness, which stays on Worker read may be stale. Package preference, last-used model (restricted or unavailable when the server says so), selected MCP/tool policy, and bounded policy counts stay behind native details. Unknown or null policy default/enforcement labels are Not reported; a wholly absent filesystem, network, or process dimension is Not recorded. Refresh workers refetches that read without catalog health refresh. A stale or failed Worker read never becomes an empty success, and an absent selected Workspace is not shown as an empty Worker inventory. Catalog entries with no authored role display Worker, including unknown or unavailable supply; runtime names never imply Coding or another role. Catalog presence alone does not make an Agent ready or running. Disabled catalog entries state that they cannot start work using fixed text derived only from the public status; private manifest readiness reasons are not exposed.

### Status inventory

The current React baseline includes the app shell, three-theme token bridge, sidebar-triggered global application search, one persistent selected-Workspace switcher, one active Conversations list with New conversation below it, archived Thread recovery, the Settings Debug component gallery and inspection panels, the deployment-admin Administration private conversation and retained-environment inspection and deletion controls, the deployment-admin Configuration file tree and JSONC editor, the deployment-admin Gateway destination for Providers, effective Models, Logical models, subscription accounts, API keys, and revision-protected configuration, live Chat, Task, Goal, Overview, selected-Workspace Agents, Knowledge, Artifacts, Recovery, Portability, Workspace changes, Repositories, Workspace Vault and Usage & audit, the bounded live Plane 1 Material surface, and internal unpublished Automations, Channels, and Generative UI review implementations. The Material surface includes identity, editing, immutable-revision history and comparison; one singular Thread binding with inclusion and queue state; and version-keyed Artifact Review proposal, base, and current comparison with conflict-safe decisions and historical decision evidence.

Thread and Overview approval cards show the bounded summary and the responsible user’s loaded complete exact effect before enabling grant. Unavailable detail states `Exact effect unavailable; approval disabled`; authorized denial and withdrawal stay available under the current request state. Detail is supplied by the existing Thread dashboard, without a preview acknowledgement command.

Prepared Worker environment review displays the measured image identity, the defaults digest and default names before admission. Activation binds both digests in the existing canonical confirmation; values are admitted only by NanoCore after fresh exact-image inspection.

Workspace review diff presentation uses the shared patch byte decoder for both UTF-8 text and exact encoded patches; presentation decoding does not change the retained bytes or digest.

Workspace discovery and account admission use `client.operations['workspace.list']({})`; discovery selects each summary's nested Workspace record. Workspace resources, Thread creation/read/items/dashboard and Turn details use the corresponding derived operation methods with one selector object. Account admission and switcher discovery remain separate TanStack views, so tests that control their timing provide explicit successive responses from the same operation. The event stream continues to use the existing Core Client subscription.

Artifact inventory, inspection, import, introduction, Action Center Review decisions and Administration inspection use definition-derived `client.operations` with explicit selectors. Existing cache keys, request identity, byte digests and Review refetch ownership remain with their hooks.

Conversation targets/navigation/submission, Task entry, attention reads, approval decisions, question answers and withdrawal use definition-derived `client.operations` with one selector object. Existing retry identities, caches and exact-effect disclosure remain with the Chat and Workspace hooks.

The Operations screen invokes `automation.*`, `scheduler.*` and `recovery.*` through `client.operations` with complete logical selector objects. Recovery retry preserves Workspace, Thread, Turn and request identities; its UI checkpoint id is excluded from the strict request. Optimistic state, rollback and frozen retry identities remain covered by `screens/operations/operations.test.tsx`.

Portability submits complete logical inputs through `client.operations` for `workspace.export`, `workspace.import-dry-run`, and `workspace.import`. The import retains its caller-owned request id and existing Workspace discovery and UI outcomes; archive download and upload retain their streaming client methods.

Generative presentation reads, refreshes and actions use `client.operations` with complete selectors and preserve deliberate action request identities.

Workspace Changes uses definition-derived `client.operations` for all fifteen synchronization reads and decisions with explicit Workspace and child selectors. Existing request generation, mutation state, refetch ownership and UI outcomes remain with the hooks.

Account invitation decisions, selected-Workspace member management, leave and ownership transfer use canonical `client.operations` inputs with logical selectors and retained request IDs. Their UI confirmation, conflict refresh, exact retry and selected-Workspace reconciliation remain in the account owner.

Workspace creation, read and rename, Workspace dashboard, Thread list/rename/archive, Turn start/interrupt/feedback and Quick Chat use the definition-derived Core Client operation map with complete logical inputs. Existing request identities and UI outcomes remain owned by their current mutation hooks and screens.

The local self-check's answer waits share `e2e/_lib/question-answer-response.ts`, which observes the browser's exact `question.answer` POST rather than an internal worker continuation. Operation response waits match the exact canonical operation path and POST method, including successful and denied `workspace.invitation-create` submissions; Material response waits retain their registered REST paths and exact methods. Its focused transport regression executes the real Core Client operation and retains the E2E successful-response and visible-answer checks.

Configuration, Administration and Gateway settings call canonical `runtime.*` and `provider-subscription.*` entries through `client.operations` with complete logical inputs. Exact file revisions, draft retention, account pair identity, reload truth and redacted quota views remain owned by the existing services.

Agents and Catalog hooks use canonical `client.operations` inputs with complete Workspace and resource selectors. Existing request identity, cache invalidation, disconnected states, exact Agent detail refresh, uploaded tree bytes and immutable version selection remain with their hooks and screens.
