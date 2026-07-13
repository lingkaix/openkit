# web

`web` is the Solid SPA used to validate the workspace protocol and product UI.

## Scope

- workspace selection and configuration
- thread and turn workflow
- live streaming items
- approvals
- unified Human Attention Action Center
- artifacts
- agent session visibility
- Goal Mode start, plan review, progress, steering, terminal evidence, artifacts, risks, and next-step visibility
- Codex ChatGPT subscription login controls
- LLM Gateway endpoint and provider capability diagnostics
- runtime config editing for server, provider, agent, and workspace config files
- protocol inspection mode

## Commands

```bash
pnpm --filter @openkit/web dev
pnpm --filter @openkit/web test
pnpm --filter @openkit/web e2e
pnpm --filter @openkit/web e2e:staging
pnpm --filter @openkit/web e2e:stories
pnpm --filter @openkit/web typecheck
pnpm --filter @openkit/web build
pnpm -w verify:release
pnpm -w verify:full
```

## Local Integration

Use this app together with `apps/nanocore` for the default product validation loop.

Start the core first:

```bash
mise exec -- pnpm --filter @openkit/nanocore dev
```

Then start the SPA:

```bash
mise exec -- pnpm --filter @openkit/web dev
```

Notes:

- the SPA uses same-origin `/api` requests in the browser
- Vite proxies `/api` to `http://localhost:3000`
- if you need a different backend origin, set `VITE_CORE_URL` for direct client calls outside the
  browser-dev proxy path
- run `pnpm --filter @openkit/web e2e` for the headless browser e2e surface
- run `pnpm --filter @openkit/web e2e:stories` for the deterministic L6 story acceptance surface backed by `tests/stories/`
- Goal Mode appears in the thread workbench when a thread is selected. Users can start a goal from an objective, draft and review a plan, approve the plan, run one real bounded worker step, observe current task and progress counts, submit active steering, see pending human attention, and inspect terminal verification evidence, artifact references, risks, and suggested next work.
- Settings Diagnostics includes the Codex ChatGPT account-slot panel for adding, renaming, deleting, browser login, device-code login, cancellation, and logout through nanocore
- Settings Portability includes local repository re-binding and imported workspace vault reference re-binding for restored or imported workspaces
- Settings Diagnostics shows LLM Gateway endpoints, provider capability chips such as `chat native`, `responses native`, and `responses bridged`, and prompt-cache usage chips with cached input token and cache hit rate summaries
- run `scripts/docker/e2e-app.sh` after building `openkit/app:dev` to execute `pnpm --filter @openkit/web e2e:staging` through the public Caddy route
- run `pnpm -w verify:full` for explicit full local validation: L0-L2 verification, nanocore e2e, web Playwright e2e, built-artifact smoke tests, and deterministic story acceptance tests
- GitHub CI keeps web e2e and story acceptance manual to avoid spending browser resources on normal pull requests or branch pushes
- v0.0.2 browser validation uses fresh data roots and does not migrate v0.0.1 JSON snapshot data

## E2E Surface

The Playwright suite covers the internal self-check full turn flow, agent session badge updates, visible Goal Mode planning, deterministic fixture completion through the test supervise endpoint, settings diagnostics refresh behavior, server-mode email/password sign-up and sign-in, unauthenticated API rejection, logout, and diagnostics redaction.

Server-mode specs start isolated NanoCore and Vite processes on dynamic ports and use disposable temporary data roots so runs do not depend on local persisted state.

The story suite uses `apps/web/playwright.stories.config.ts` to execute Markdown story artifacts from `tests/stories/` through deterministic Playwright adapters in `tests/story-runner/`. The deterministic Web story runs the local self-check flow without real Codex, real provider credentials, or external network access. The real Codex Goal Mode story is an MCP-first kernel acceptance run with a separate opt-in command, `pnpm -w test:stories:real-codex`; it does not claim Web or Playwright coverage.
