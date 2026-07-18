# OpenKit End-User Skill

This directory contains one repository-authored Skill named `openkit` for agents helping end users operate OpenKit. The accepted design is defined by [`docs/specs/20260713-openkit_agent_skill_interface.md`](../docs/specs/20260713-openkit_agent_skill_interface.md), and implementation is tracked by [`docs/changes/202607131935040001-openkit_agent_skill_interface.md`](../docs/changes/202607131935040001-openkit_agent_skill_interface.md).

## Package

The package contains one concise `skills/openkit/SKILL.md`, generated `agents/openai.yaml` metadata, one bundled `scripts/openkit` CLI entrypoint, and one-level `references/` material for setup, loop operation, knowledge, recovery, administration, and capability discovery.

The Skill is end-user-only. It combines connection setup, diagnostics, workspace operation, Chat Mode, Task Mode, Goal Mode, bounded loop guidance, Action Center decisions, artifacts, evidence, knowledge, recovery, runtime configuration, vault administration, audit, usage, automations, Git operations, and workspace portability without adding a developer audience switch or repository self-improvement mode.

The bundled CLI progressively exposes every supported public end-user and operator NanoCore capability through operation search, description, and invocation. The Skill and CLI do not expose private NanoCore internals, generic shell access, arbitrary HTTP access, or worker-side capability supply.

## Boundary

Do not reintroduce user-facing MCP, setup-only, loop-only, developer, or self-improvement variants. Worker-side MCP tool supply belongs to the separate Agent Capability plane; it is not part of this Skill, and current AEPs expose no worker capability routes.
