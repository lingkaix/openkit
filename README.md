# OpenKit

OpenKit is an agent workspace for delegating, supervising, preserving, and improving real work across multiple agent runtimes.

It is not another heavy agent runtime. OpenKit coordinates mature runtimes such as Codex, OpenCode, Pi Agent, and future worker agents through a small Core, durable workspace history, human review points, artifacts, and stable product channels.

## Why OpenKit Exists

Individual AgentSessions are useful, but they are hard to manage as a work system. Context is scattered, approvals are ad hoc, artifacts are easy to lose, follow-up work is detached from prior attempts, and long-running tasks rarely have a durable record that humans can inspect.

OpenKit turns those isolated sessions into a managed workspace:

- assign work to agents from a durable thread
- track progress, risks, approvals, and human attention
- preserve artifacts, evidence, knowledge, and review records
- resume or refine work without losing context
- coordinate agent runtimes without exposing their native internals as the product model
- keep credentials, permissions, audit, and runtime placement under Core control as the system matures

## Current Status

OpenKit is in internal developer-preview development.

The accepted release posture is deliberately NanoCore-first and end-user Agent-Skill-first. Core mechanisms stabilize at the NanoCore App API layer, then one progressively disclosed `openkit` Skill and its bundled CLI project the complete supported user/operator capability surface. The Web UI remains part of the product direction, but it follows stable NanoCore APIs rather than driving core behavior.

The unified Skill and bundled CLI are implemented under `skills/openkit/`. User-facing MCP and split setup/loop Skill variants have been removed and must not be reintroduced.

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
- `skills/`: one end-user `openkit` Skill, its bundled CLI, and progressively disclosed operating guidance.
- `apps/web`: the browser product surface over stabilized NanoCore APIs.
- `packages/protocol`: stable Core protocol schemas and generated JSON Schema outputs.
- `packages/app-api-schemas`: shared NanoCore App API schemas for product read models and admin/config surfaces.
- `packages/core-client`: typed HTTP and SSE client used by the SPA and protocol tests.
- `packages/config-schema`: shared configuration schemas, policy metadata, and workspace root materialization helpers.

## What Works Now

- NanoCore local and server-mode foundations.
- Durable workspace, thread, turn, item, artifact, knowledge, AgentSession, approval, automation, and review-related storage foundations.
- Goal Mode for objective capture, plan review, bounded steps, verification evidence, and terminal completion state.
- Action Center read models for human attention, approvals, blocked work, and follow-up decisions.
- Workspace repository linking, sync records, review records, apply results, artifacts, and evidence bundles through public NanoCore contracts.
- One end-user-only `openkit` Skill with progressive operation discovery and a bundled CLI over public NanoCore contracts.
- OpenShell and worker-path foundations for running bounded work through NanoCore-managed coordination.
- Focused static, package, NanoCore, channel, smoke, and story-test layers for release validation.

## Agent Skill Interface Direction

The accepted AI-native interface is the end-user Skill at `skills/openkit/` with its bundled CLI. The Skill teaches setup, diagnostics, workspace operation, Chat Mode, Task Mode, Goal Mode, bounded loops, Action Center decisions, artifacts, evidence, knowledge, recovery, runtime configuration, vault administration, audit, usage, automations, Git operations, and workspace portability.

The CLI uses a small agent-first command contract: `openkit doctor`, `openkit ops search`, `openkit ops describe`, and `openkit ops call`. It exposes public NanoCore capabilities progressively rather than advertising a flat eager tool catalog. User-facing MCP compatibility layers and developer Skill variants are prohibited.

The executable package lives under `skills/openkit/`; agents resolve its `scripts/openkit` entrypoint relative to the installed Skill directory. The owning contract is [`docs/specs/20260713-openkit_agent_skill_interface.md`](./docs/specs/20260713-openkit_agent_skill_interface.md).

## Web UI

The Web UI is still part of the product. In the current development model, it is no longer the default starting point for core behavior. The Web surface should consume stable NanoCore APIs and present the same kernel concepts through a polished product interface after the kernel contract is reliable.

Run the local Web surface when you need to inspect the current browser experience:

```bash
pnpm --filter @openkit/web dev
```

NanoCore listens on `http://localhost:3000` by default, and the Web app uses its Vite `/api` proxy for local development.

## Deployment And Releases

Use the deployment docs instead of this README for operational detail.

- [`docs/deployment.md`](./docs/deployment.md) defines the stable deployment model.
- [`docs/manual/nanocore-deployment-modes.en.md`](./docs/manual/nanocore-deployment-modes.en.md) explains source and container deployment modes.
- [`docs/cookbooks/release.md`](./docs/cookbooks/release.md) explains how to cut a version tag, run the release gate, publish release images, and verify GitHub Release notes.
- [`docs/cookbooks/docker-app.md`](./docs/cookbooks/docker-app.md) explains the local app container image workflow.

## Common Commands

Repository commands are the `scripts` in root `package.json` and are invoked as bare `pnpm ...`. `bash scripts/repo-init.sh` installs the pinned toolchain and checks that bare `node` and `pnpm` resolve to it.

```bash
pnpm run check:repo
pnpm --filter @openkit/nanocore test
pnpm verify
pnpm verify:release
pnpm verify:full
```

Prepare and prove the repository's admitted A1 test host before real NanoHost acceptance work:

```bash
pnpm host:provision a1
pnpm host:assert a1
pnpm host:nanohost:bring-up a1
pnpm host:teardown a1
```

The bring-up command requires attempt-local NanoCore admin inputs and always tears down the NanoHost service and its credential slots. Retain the redacted two-cycle result at `temp/state/nanohost/host-manifest/a1/result.json`; see the [NanoHost real-use host cookbook](./docs/cookbooks/nanohost-real-use-host.md).

Use focused package commands while developing and run release gates before tagging.

Ordinary checks run on the developer host by default. A Worker Agent sandbox is also permitted. CI runs every gate inside the `test-env` image, and that image result is authoritative when environments disagree. An image second opinion is an explicit `OPENKIT_TEST_USE_IMAGE=1` run; it never retries a failed host command, and each result is labelled with `OPENKIT_TEST_ENVIRONMENT`. Docker is not a prerequisite for ordinary commands. The NanoCore restart gate and the real-provider, real-subscription, and real-task-mode gates drive Docker or a real runtime/provider themselves and therefore stay on the host. See the Test Execution Environment decision in [`docs/toolchain.md`](./docs/toolchain.md).

## Repository Layout

```text
.
├── apps/                   # NanoCore and Web product surfaces
├── packages/               # Shared protocol, App API, config, and client packages
├── skills/                 # Unified end-user Skill and bundled CLI
├── docs/                   # Core docs, specs, cookbooks, changes, and audits
├── scripts/                # Bootstrap and helper scripts
├── .mise.toml              # Pinned tool versions for bootstrap
├── AGENTS.md               # Agent execution rules
└── CONTRIBUTING.md         # Human workflow and review guide
```

## Where To Read More

- [`AGENTS.md`](./AGENTS.md): execution rules for agents working in this repository.
- [`skills/README.md`](./skills/README.md): unified end-user Skill package and interface boundaries.
- [`docs/core/work-model.md`](./docs/core/work-model.md): stable user-facing work model.
- [`docs/deployment.md`](./docs/deployment.md): stable deployment model.
- [`docs/product-vision.md`](./docs/product-vision.md): long-term product direction.
- [`docs/roadmap.md`](./docs/roadmap.md): roadmap and version-scope planning.
- [`docs/specs/20260713-openkit_agent_skill_interface.md`](./docs/specs/20260713-openkit_agent_skill_interface.md): canonical end-user Agent Skill Interface contract.
- [`apps/README.md`](./apps/README.md): application sub-project expectations.
- [`packages/README.md`](./packages/README.md): shared package inventory.
- [`docs/change-execution.md`](./docs/change-execution.md): governance for material change execution and change-record content.
- [`docs/verification-instruments.md`](./docs/verification-instruments.md): governance for what makes a verdict believable — oracle classification, harness admission, and execution environment.

## License

License information is not finalized yet.
