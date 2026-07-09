# OpenKit

OpenKit is an agent workspace for delegating, supervising, preserving, and improving real work across multiple agent runtimes.

It is not another heavy agent runtime. OpenKit coordinates mature runtimes such as Codex, OpenCode, Pi Agent, and future worker agents through a small Core, durable workspace history, human review points, artifacts, and stable product channels.

## Why OpenKit Exists

Individual agent sessions are useful, but they are hard to manage as a work system. Context is scattered, approvals are ad hoc, artifacts are easy to lose, follow-up work is detached from prior attempts, and long-running tasks rarely have a durable record that humans can inspect.

OpenKit turns those isolated sessions into a managed workspace:

- assign work to agents from a durable thread
- track progress, risks, approvals, and human attention
- preserve artifacts, evidence, knowledge, and review records
- resume or refine work without losing context
- coordinate agent runtimes without exposing their native internals as the product model
- keep credentials, permissions, audit, and runtime placement under Core control as the system matures

## Current Status

OpenKit is in internal developer-preview development.

The current release posture is deliberately kernel-first. Core mechanisms are implemented at the NanoCore layer, callable by an external coordinator agent through `@openkit/mcp`, and verified through focused core tests. The Web UI remains part of the product direction, but it follows stable NanoCore APIs rather than driving core behavior.

Use this preview when you want to evaluate or dogfood the OpenKit work loop with a desktop AI application acting as coordinator.

## Core Model

OpenKit uses a small product backbone:

```text
Workspace -> Thread -> Turn -> Item[]
```

- `Workspace` owns history, repositories, agents, artifacts, knowledge, settings, permissions, audit records, and future collaboration scope.
- `Thread` is the durable container for one stream of related work.
- `Turn` is one bounded execution step or attempt inside a thread.
- `Item` is the visible event and history unit for messages, status, tool summaries, approvals, errors, artifacts, and evidence.
- `Artifact` is a durable output that can be reviewed, reused, exported, or referenced later.

## Main Modules

- `apps/nanocore`: the kernel and public App API server for workspaces, threads, Goal Mode, Action Center, artifacts, runtime config, auth, storage, and worker coordination.
- `mcp/`: `@openkit/mcp`, the stdio MCP channel that lets desktop AI applications operate NanoCore through public contracts.
- `skills/`: OpenKit-authored setup and loop Skills for MCP-capable desktop AI applications.
- `apps/web`: the browser product surface over stabilized NanoCore APIs.
- `packages/protocol`: stable Core protocol schemas and generated JSON Schema outputs.
- `packages/app-api-schemas`: shared NanoCore App API schemas for product read models and admin/config surfaces.
- `packages/core-client`: typed HTTP and SSE client used by the SPA and protocol tests.
- `packages/config-schema`: shared configuration schemas, policy metadata, and workspace root materialization helpers.

## What Works Now

- NanoCore local and server-mode foundations.
- Durable workspace, thread, turn, item, artifact, knowledge, agent session, approval, automation, and review-related storage foundations.
- Goal Mode for objective capture, plan review, bounded steps, steering, verification evidence, and terminal completion state.
- Action Center read models for human attention, approvals, blocked work, and follow-up decisions.
- Workspace repository linking, sync records, review records, apply results, artifacts, and evidence bundles through MCP-facing flows.
- `@openkit/mcp` as the primary dogfooding channel for external coordinator agents.
- OpenKit setup and loop Skills: `openkit-setup`, `openkit-setup-dev`, `openkit-loop`, and `openkit-loop-dev`.
- OpenShell and worker-path foundations for running bounded work through NanoCore-managed coordination.
- Focused static, package, NanoCore, MCP, smoke, and story-test layers for release validation.

## Try The MCP-First Loop

Start NanoCore:

```bash
mise exec -- pnpm --filter @openkit/nanocore dev
```

Build and run the MCP server:

```bash
mise exec -- pnpm --filter @openkit/mcp build
OPENKIT_NANOCORE_URL=http://127.0.0.1:3000 mise exec -- pnpm --filter @openkit/mcp start
```

For source development, use:

```bash
mise exec -- pnpm --filter @openkit/mcp dev
```

Configure your MCP-capable desktop AI application with the `openkit-mcp` package entrypoint or the package start command described in [`mcp/README.md`](./mcp/README.md). Use [`skills/README.md`](./skills/README.md) to choose the right Skill:

- `openkit-setup`: connect an end-user desktop AI app to an existing NanoCore backend.
- `openkit-setup-dev`: prepare this repository for local NanoCore plus MCP dogfooding.
- `openkit-loop`: coordinate bounded end-user workspace work.
- `openkit-loop-dev`: coordinate review-gated OpenKit self-improvement.

## Web UI

The Web UI is still part of the product. In the current development model, it is no longer the default starting point for core behavior. The Web surface should consume stable NanoCore APIs and present the same kernel concepts through a polished product interface after the kernel contract is reliable.

Run the local Web surface when you need to inspect the current browser experience:

```bash
mise exec -- pnpm --filter @openkit/web dev
```

NanoCore listens on `http://localhost:3000` by default, and the Web app uses its Vite `/api` proxy for local development.

## Deployment And Releases

Use the deployment docs instead of this README for operational detail.

- [`docs/deployment.md`](./docs/deployment.md) defines the stable deployment model.
- [`docs/nanocore-deployment-modes.en.md`](./docs/nanocore-deployment-modes.en.md) explains source and container deployment modes.
- [`docs/cookbooks/release.md`](./docs/cookbooks/release.md) explains how to cut a version tag, run the release gate, publish release images, and verify GitHub Release notes.
- [`docs/cookbooks/docker-app.md`](./docs/cookbooks/docker-app.md) explains the local app container image workflow.

## Common Commands

Prefer `mise exec --` or `mise run` so the repository toolchain comes from `.mise.toml`.

```bash
mise exec -- pnpm run check:repo
mise exec -- pnpm --filter @openkit/nanocore test
mise exec -- pnpm --filter @openkit/mcp test
mise exec -- pnpm --filter @openkit/mcp typecheck
mise exec -- pnpm --filter @openkit/mcp smoke:nanocore
mise run verify
mise run verify-release
mise run verify-full
```

Use focused package commands while developing and run release gates before tagging.

## Repository Layout

```text
.
├── apps/                   # NanoCore and Web product surfaces
├── mcp/                    # @openkit/mcp stdio control channel
├── packages/               # Shared protocol, App API, config, and client packages
├── skills/                 # OpenKit-authored setup and loop Skills
├── docs/                   # Core docs, specs, cookbooks, changes, and working logs
├── scripts/                # Bootstrap and helper scripts
├── .mise.toml              # Tool versions and top-level tasks
├── AGENTS.md               # Agent execution rules
└── CONTRIBUTING.md         # Human workflow and review guide
```

## Where To Read More

- [`AGENTS.md`](./AGENTS.md): execution rules for agents working in this repository.
- [`mcp/README.md`](./mcp/README.md): `@openkit/mcp` setup, tools, commands, and smoke tests.
- [`skills/README.md`](./skills/README.md): OpenKit Skill selection guide.
- [`docs/core/work-model.md`](./docs/core/work-model.md): stable user-facing work model.
- [`docs/deployment.md`](./docs/deployment.md): stable deployment model.
- [`docs/product-vision.md`](./docs/product-vision.md): long-term product direction.
- [`docs/roadmap.md`](./docs/roadmap.md): roadmap and version-scope planning.
- [`docs/specs/20260617-openkit_ai_interface.md`](./docs/specs/20260617-openkit_ai_interface.md): AI-native product channel boundary.
- [`apps/README.md`](./apps/README.md): application sub-project expectations.
- [`packages/README.md`](./packages/README.md): shared package inventory.
- [`docs/change-tracking.md`](./docs/change-tracking.md): rules for specs, changes, and working logs.

## License

License information is not finalized yet.
