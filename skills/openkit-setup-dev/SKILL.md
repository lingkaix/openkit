---
name: openkit-setup-dev
description: Set up an OpenKit repository checkout for developer dogfooding through local NanoCore and the OpenKit stdio MCP server. Use when Codex, Pi Agent, Claude CoWork, or another MCP-capable desktop agent app is working inside the OpenKit source tree and needs to bootstrap dependencies, start the local NanoCore development backend, configure MCP, run setup diagnostics or smoke checks, verify repository readiness, or hand off to `openkit-loop-dev` for review-gated self-improvement work. Do not use for normal end-user setup; use `openkit-setup` instead.
---

# OpenKit Developer Setup

## Use This Skill When

Use this Skill when the agent app is allowed to work inside `/Users/m5pro/Documents/AI/openkit` or another OpenKit checkout and needs developer setup guidance for connecting the checkout to OpenKit through MCP.

The OpenKit MCP server is a standard stdio MCP channel facade over NanoCore. It is parallel to the Web UI and is not worker-side MCP supply, a shell, a package manager, a backend supervisor, or a NanoCore internal admin API.

After setup is working, use `openkit-loop-dev` for Goal Mode, Action Center review, `docs/changes/` lifecycle records, and self-improvement loop coordination.

## Do Not Use This Skill For

- Normal end-user OpenKit setup. Use `openkit-setup`.
- Running the development loop itself. Use `openkit-loop-dev` after setup.
- Bypassing NanoCore public APIs, approval gates, review gates, or human decisions.

## Developer Setup

Start from the repository root.

```bash
bash scripts/repo-init.sh
```

Start the local development NanoCore backend in a dedicated terminal.

```bash
pnpm --filter @openkit/nanocore dev
```

Build and run the OpenKit MCP server through the desktop AI app's stdio MCP configuration.

```bash
pnpm --filter @openkit/mcp build
OPENKIT_NANOCORE_URL=http://127.0.0.1:3000 pnpm --filter @openkit/mcp start
```

Configure the desktop AI app with command `pnpm`, args `["--filter", "@openkit/mcp", "start"]`, cwd set to the OpenKit checkout, and `OPENKIT_NANOCORE_URL` set to `http://127.0.0.1:3000`.

Use `OPENKIT_WORKSPACE_ID=ws_demo` unless the user names another workspace. Use `OPENKIT_REPO_ROOT` only as a repository path hint, not as permission to mutate the repository.

## Setup Verification Calls

Always begin with `openkit.read_status`.

Explain NanoCore reachability, workspace id, repository readiness, active Goal Mode state, and Action Center counts before taking action.

When the OpenKit checkout should be linked, confirm the path with the human, call `openkit.link_repository`, then call `openkit.read_repositories` and continue only when diagnostics are ready.

Do not create goals or resolve Action Center items from this setup Skill. Switch to `openkit-loop-dev` when the human wants to start developer loop work.

## Developer Context

Use this repository's change-tracking discipline for material development work.

Read `AGENTS.md` and `docs/change-tracking.md` before planning changes.

Create or update a material change record under `docs/changes/` only when setup work itself becomes a material repository change. Use `openkit-loop-dev` for change records attached to self-improvement loops.

## Setup Verification

For dogfood setup verification, run:

```bash
pnpm --filter @openkit/nanocore build
pnpm --filter @openkit/mcp build
pnpm --filter @openkit/mcp smoke:nanocore
```

Set `OPENKIT_MCP_SMOKE_REPOSITORY=/Users/m5pro/Documents/AI/openkit` only when the human wants the smoke to link this checkout as the repository under test.

## Handoff

When status, repository diagnostics, and MCP startup are healthy, tell the human that setup is complete and recommend `openkit-loop-dev` for coordinated OpenKit self-improvement.

Do not hide failing checks.

Real Codex or provider-quota work must be opt-in and explicitly approved by the human.
