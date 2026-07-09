# NanoCore Black-Box E2E Harness

Status: Superseded

Superseded by `docs/specs/20260529-test_strategy.md` and `docs/specs/20260529-l6_story_acceptance.md`.

This document is retained as supporting detail for the original NanoCore black-box E2E harness slice.

## Goal

NanoCore needs release-review tests that exercise the built HTTP process instead of in-process app or store imports.

## Harness

- `apps/nanocore/e2e/_lib/harness.ts` starts `pnpm --filter @openkit/nanocore start` from the repository root.
- `test:e2e` runs `pnpm run build` first, so the spawned process uses `dist/index.js`.
- The harness allocates a localhost port, creates or reuses a data root, sets `OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR=1`, waits for `/api/health`, and terminates the child process after each spec.
- The harness accepts an `OPENKIT_CORE_MODE` override so server-mode e2e specs can reuse it later.

## Boundary

- E2E specs use HTTP, SSE, filesystem reads, and `better-sqlite3`.
- The import-boundary spec scans e2e import statements and fails if a spec imports from `apps/nanocore/src`.
- Unit Vitest excludes `e2e/**`; e2e runs only through `apps/nanocore/vitest.e2e.config.ts`.

## File Projections

`FsStore` still writes `store.json` as the authoritative workspace snapshot, and now also writes black-box friendly projections:

- `users/<userId>/workspaces/<workspaceId>/workspace.json`
- `users/<userId>/workspaces/<workspaceId>/threads/<threadId>/thread.json`
- `users/<userId>/workspaces/<workspaceId>/threads/<threadId>/turns/<turnId>/turn.json`
- `users/<userId>/workspaces/<workspaceId>/threads/<threadId>/turns/<turnId>/items.jsonl`

These files let process-level tests inspect persisted workspace, thread, turn, and item state without importing store internals.

## Covered Specs

- `boot-empty.spec.ts` verifies local-mode boot from an empty data root, `/api/health`, filesystem layout, and `core.sqlite`.
- `local-full-turn.spec.ts` drives an internal self-check turn through `/api/turns`, SSE, approval response, and user-input response, then verifies projection files and the `user_local` SQLite row.
- `local-restart-replay.spec.ts` completes a turn, restarts NanoCore against the same data root, and verifies `/api/app/*` read models replay the turn, artifact, and items.
