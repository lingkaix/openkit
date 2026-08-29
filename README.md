# OpenKit

> **The shared AI workspace for smart teams.**

**Shared agents. Shared knowledge. One team.**

OpenKit gives every member of a small, high-impact human team access to the same agents, tasks, information, Knowledge, Skills, decisions, and work history. Agents are shared teammates rather than personal assistants: one person can delegate work, another can continue or review it, and everyone can build on the same discoveries and results.

People and agents work, share, and improve together. Useful discoveries become shared Knowledge, proven ways of working become reusable Skills, and each completed project improves how the whole team works next time.

## What OpenKit Is

OpenKit gives a human leader one place to direct an agent team, see who is doing what, review consequential decisions, preserve useful outputs, and continue work without reconstructing its context from scattered sessions.

It is an all-in-one workspace and workbench, not an all-in-one IT system. OpenKit connects the CMS, CRM, BI, analytics, communication, development, and other specialist systems a team already trusts; it does not try to replace their domain capabilities or authoritative data.

OpenKit is designed to absorb routine operational complexity. NanoCore agents should prepare and maintain Workspaces, Worker Agents, sandbox images, Agent Environment Packages, and Policies within user authorization and Core governance, so users primarily provide goals, constraints, permissions, preferences, and the judgement only a human can supply. Manual configuration remains available to operators for explicit control and exceptional cases.

## Why Use OpenKit

- **Direct a team, not a toolchain.** Delegate work through one consistent model while specialized agents and runtimes handle the execution details.
- **Keep human judgement in control.** Use review points, comparisons, annotations, approvals, and localized corrections to turn tacit judgement into precise agent direction.
- **Make work durable.** Preserve work history, artifacts, evidence, knowledge, decisions, and follow-up context instead of losing them at the end of an AgentSession.
- **Reduce management overhead.** Let the product manage routine agent, Workspace, Policy, and runtime preparation as these capabilities mature, while surfacing only decisions that require human authority.
- **Fit the systems you already use.** Bring tools, data, people, and agents together without rebuilding every vertical application inside OpenKit.
- **Improve how the team works.** Use governed outcomes and Telemetry to evaluate and improve Skills, Knowledge, scheduling, sandbox policy, and reusable working models over time.

## Who OpenKit Is For

OpenKit is built for high-agency individuals and typically three-to-five-person expert teams whose work spans research, learning, creation, operations, and software. It is intended for end users, including non-technical users, who want to lead a human + agent team without becoming an agent-runtime operator.

## Product Experience

The primary experience is conversation-first but not chat-only. A user can move from a quick question to a bounded Task or a reviewed Goal, see active work and handoffs, intervene through the Action Center, inspect artifacts and evidence, and carry accepted knowledge into future work.

The durable product backbone is intentionally small: a Workspace holds related Threads, each Thread records bounded Turns, and Items make messages, status, approvals, errors, artifacts, and evidence visible. External systems remain authoritative for the domain data they own.

Read the [Product Vision](./docs/product-vision.md) for the long-term direction, the [Work Model](./docs/core/work-model.md) for the stable product concepts, and the [Product Roadmap](./docs/roadmap.md) for the ordered path from the current system to the complete vision.

## Current Status

OpenKit is in internal developer preview. The implemented product centers on NanoCore local and server foundations, durable Workspace history, Goal Mode, the Action Center, artifacts, evidence, Knowledge foundations, one end-user `openkit` Skill with its bundled CLI, and bounded worker execution through NanoCore-managed coordination.

The NanoCore App API is the current stabilization boundary. The Web UI remains part of the product direction and follows stable NanoCore capabilities instead of defining Core behavior.

For end-user guidance, start with the [Getting Started manual](./docs/manual/getting-started.en.md) and [Using OpenKit manual](./docs/manual/using-openkit.en.md). These two pages currently preserve the required manual scope while the release experience is still being completed.

## For Operators

### Installation And Deployment

Use the [NanoCore Deployment Modes manual](./docs/manual/nanocore-deployment-modes.en.md) for supported source and container deployment paths, prerequisites, startup, and verification. The [Deployment Model](./docs/deployment.md) is the cross-owner map for the underlying contracts.

### Manual Configuration

Use the [NanoCore DATA_ROOT Config manual](./docs/manual/nanocore-data-root-config.en.md) for server mode, authentication, NanoHost, Vault, providers, agents, defaults, and gateway configuration. Manual configuration is the operator escape hatch; it is not the intended day-to-day end-user experience.

### Updates, Maintenance, Backup, And Recovery

The [NanoCore Operations manual](./docs/manual/nanocore-operations.en.md) records the required scope for upgrades, health checks, routine maintenance, backup and restore, credential continuity, runtime image changes, troubleshooting, and recovery. Its executable procedures will be filled in as the corresponding release paths stabilize.

Use the [Sandbox Container Tests manual](./docs/manual/sandbox-container-tests.en.md) only when verifying container behavior from an environment that cannot start nested containers.

## For Developers And Contributors

### Start Contributing

Read the [Contributing Guide](./CONTRIBUTING.md) for the development and review workflow. Use the [Toolchain guide](./docs/toolchain.md) for repository setup, dependencies, pinned tools, test environments, and canonical command ownership.

### Understand The System

Start with the [documentation index](./docs/INDEX.md), then read [Foundation](./docs/core/foundation.md), [Architecture](./docs/core/architecture.md), and the [Work Model](./docs/core/work-model.md). Component-specific entry points live in the [apps guide](./apps/README.md), [packages guide](./packages/README.md), and [Skill guide](./skills/README.md).

### Plan, Implement, And Verify Changes

Use [Change Execution](./docs/change-execution.md) for material-work coordination, [Verification Instruments](./docs/verification-instruments.md) for evidence quality, and the [Documentation Model](./docs/documentation-model.md) for document authority and lifecycle. Maintainers preparing a release should follow the [Release Cookbook](./docs/cookbooks/release.md) and its owning [Release Management specification](./docs/specs/20260829-release_management.md).

Agent contributors must also follow the repository [Agent Execution Contract](./AGENTS.md).

## License

OpenKit is licensed under the [Apache License 2.0](./LICENSE).
