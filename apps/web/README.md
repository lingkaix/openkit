# @openkit/web

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

The published Tier-A **AI interface** and **Configuration** screens are separately authorized deployment-administration workflows inside the Settings shell. They use the current browser session only: NanoCore derives deployment-admin authority when the signed-in active canonical User owns a currently usable `server-admin` Token, so Web never asks for, stores, or replays Token plaintext. General Workspace settings remain outside the Settings shell, read only the selected Workspace, expose its ordinary-user default model, Agent, and Skill controls, and never request deployment diagnostics or runtime config. Configuration uses the existing `client.runtimeConfig` file, validation, revision, and safe-reload contract.

The Tier-A Settings **Administration** screen uses the same session-derived deployment-admin authority without accepting Token plaintext. Its private administration conversation is a distinct Thread entry in the current User's Quick Chat Workspace and continues only through the dedicated administration conversation endpoint. Environment preparation reads an actual published Server Agent manifest and its exact configuration SHA, then keeps authored and resolved candidates in that private Thread. Result-only recovery uses the exact authored Artifact; human activation reuses the response's payload-bound confirmation and shows the shared Agent's later-admission scope, optional exact current Thread and successor prompt, configuration result, and each retained environment disposition. The globally selected Workspace separately scopes immediate-replacement Thread selection, the retained Worker environment list, current host status, and explicit whole-environment deletion. Deletion is bound to the displayed environment revision, and an unknown host result requires a fresh status inspection before another effect request.

The accepted ordinary Workspace Vault placement is read-only and uses exactly `client.app.listWorkspaceVaultReferences`, `client.app.listWorkspaceVaultGrants`, `client.app.listWorkspaceVaultInjectionPlans`, `client.app.listWorkspaceVaultInjectionReceipts`, and `client.app.listWorkspaceVaultUseRecords` for the selected Workspace. It does not request or project deployment-admin backend status; that status is deferred to a separately accepted future server-admin Web surface. The permission and multi-user Workspace specifications own that authority separation.

The live Tier-A board-17 **Usage & audit** screen is implemented as a read-only projection scoped to the selected Workspace. It uses exactly `client.app.getCapabilityUsage`, `client.app.listWorkspaceAuditEvents`, and `client.app.listWorkspacePermissionDecisions` with that validated Workspace, and it never calls or projects `client.app.listServerAuditEvents`. Deployment-admin server audit is deferred to a separately accepted future admin surface.

The live Tier-A board-19 **Repositories** screen projects selected-Workspace repository resources, diagnostics, default-repository setup, durable push records, and the existing approval-gated Git push workflow through `client.repositories`. It requests approval for one exact target, executes only a matching granted approval, and re-reads the authoritative repository projection without adding an API or external-effect owner. Its approval response remains TanStack mutation data, and its route appears once in the compact Workspace destination row above Settings. Workspace Sync review-to-apply is a separate live **Workspace changes** surface. The selected Workspace is controlled only by the persistent primary switcher below the sidebar brand row; page-local switchers are absent, active Threads share one Conversations list because Chat and Task are modes on the same Thread, and archived Threads have a compact destination with Restore. Focused tests cover this Web projection; no real external push is claimed here.

The live Tier-A **Catalog** screen projects selected-Workspace Skill, MCP, and Agent Plugin catalog management through `client.catalog`. It imports SKILL.md trees, pins current Skill versions, creates inactive MCP configurations, toggles enablement, and imports plugin.json packages. Native Codex plugin loading is not advertised. Stdio MCP enablement remains a deployment-admin authority on the server. Writes stay disabled while disconnected.

The live Chat surface renders `generative-ui-reference` Thread Items through the eight native A2UI types mapped onto OpenKit primitives. Kernel create and record writes stay agent-first. The `/generative` fixture shell remains unpublished Tier C.

Surfaces that run ahead of a stable kernel contract may retain internal review implementations, but published navigation and routing omit them until they become live (DESIGN.md §11).

The Settings **Debug** surface contains the component catalog and is the single Web placement for future developer-facing inspection panels after their contracts and authorization are accepted.

Shared Modal surfaces stay within the padded viewport and scroll long content so confirmation controls remain reachable. React Aria continues to own focus containment, Escape dismissal and focus restoration.

Settings **App update** projects deployment-admin prepare, start and status operations through `client.app`. It is scoped to the deployment, independent of the selected Workspace. The administrator reviews an immutable prepared source and explicitly consents to maintenance; the host receipt owns the result across App restarts. The deployed host helper must be configured before this surface can perform an update.

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
- **A2UI native Chat renderer** — live Thread Items of type `generative-ui-reference` render through official `@a2ui/react@0.11.0` v0.9. The unpublished `/generative` fixture shell remains Tier C.
- **Iconify + Remix Icon** — icons for the primitive and screen tiers.
- **Biome** — lint/format (repo-wide config). **Vitest** + Testing Library — unit.
  **Playwright** — e2e.

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
    portability/      Tier-A User Settings import plus project-Workspace export and Vault rebind
    workspace-sync/   Tier-A Workspace change review, apply evidence, and recovery decisions
    workspace/        Tier-A Overview, Agents, Knowledge, First-run, Repositories, ArchivedThreadsScreen, New workspace
    settings/         Tier-A General, Administration, Configuration, AI interface, My admin access, Access tokens, Debug, Vault, Usage & audit
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

## Status

The current React baseline includes the app shell, three-theme token bridge, sidebar-triggered global application search, one persistent selected-Workspace switcher, one active Conversations list with New conversation below it, archived Thread recovery, the Settings Debug component gallery and inspection panels, the deployment-admin Administration private conversation and retained-environment inspection and deletion controls, the deployment-admin Configuration file tree and JSONC editor, the deployment-admin AI interface for subscription accounts, provider profiles, API keys, and core and gateway defaults, live Chat, Task, Goal, Overview, selected-Workspace Agents, Knowledge, Artifacts, Recovery, Portability, Workspace changes, Repositories, Workspace Vault and Usage & audit, the bounded live Plane 1 Material surface, and internal unpublished Automations, Channels, and Generative UI review implementations. The Material surface includes identity, editing, immutable-revision history and comparison; one singular Thread binding with inclusion and queue state; active-turn exact-revision delivery and terminal outcomes; and version-keyed Artifact Review proposal, base, and current comparison with conflict-safe decisions and historical decision evidence. The Claude Design board inventory is a non-exhaustive visual reference, not evidence that every product surface is implemented.

Chat and Task Thread streams render every non-secret user-input Gate as accessible inline text or option controls and submit one complete answer map through the existing Core Client Turn command. Pending submission is disabled, a failed command retains its exact map for retry, and secret-bearing, connection-checking, or disconnected Gates remain visible without a submit action. An approval request remains legible after an approval decision with the same Turn and approval id appears, while its Approve and Deny controls are no longer rendered. The isolated Playwright stack can restart only NanoCore on its existing port and data root while keeping the Web process live, and its final stop still owns complete process and temporary-root cleanup.

Board 19 is live as a Tier-A selected-Workspace repository resources, diagnostics, default-repository setup, durable push records, and approval-gated push projection. The old Repositories demo, fixture, and export are absent. Existing Core Client and NanoCore contracts remain the owners; this Web package adds no API or external-effect owner. Workspace Sync review-to-apply and recovery evidence are live on the separate Workspace changes surface; no real external-push proof is claimed here.

The current account boundary uses `client.app.listAuthorizedWorkspaces()` for admission, opens the account gate only for the exact typed `401 core.auth.unauthenticated`, offers the existing email/password sign-up and sign-in operations, and exposes sign-out on the authenticated Account route; focused tests and the isolated server-mode browser journey cover this boundary, while real-use proof remains pending.

Selected-Workspace owner member administration, owner-issued invitation administration, the membership-independent account-level My invitations direct read with pending accept and decline decisions plus terminal rows, and selected active non-owner self-leave are focused-test-backed implementations through the existing Account route and the isolated server-mode browser journey; real-use and program-exit proof remain pending. The ordinary-user operation guard covers all 141 included operations; only Automation CRUD and Knowledge proposal draft/reversal remain deliberately unpublished under R092, R070, and R072. The stack specification remains `Partial` because the Spectrum token package is still absent even though official A2UI v0.9 renderer packages are pinned for Chat Item rendering. Follow the current design→code loop in [`docs/cookbooks/claude-design-web-ui-loop.md`](../../docs/cookbooks/claude-design-web-ui-loop.md).

## Related docs

- Canonical design guide — [`DESIGN.md`](../../DESIGN.md)
- Web stack + token-bridge contract — [`docs/specs/20260710-web_ui_rebuild_stack.md`](../../docs/specs/20260710-web_ui_rebuild_stack.md)
- Product-surface projection — [`docs/specs/20260628-web_product_surface_projection.md`](../../docs/specs/20260628-web_product_surface_projection.md)
- Client boundary — `@openkit/core-client`
