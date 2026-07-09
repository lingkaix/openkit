# Template Overview

This document is the high-level source of truth for the monorepo template itself. It explains what the template is for, what it includes, what it does not include, and how it should evolve without drifting away from its original design.

## Purpose

This template is designed for projects where most day-to-day implementation work is performed by AI agents rather than humans typing code or running commands manually.

The template exists to make that workflow practical:

- Easy for an agent to understand quickly
- Easy for multiple agents to work on in parallel
- Easy for humans to review, supervise, and audit
- Harder for the repository to drift into chaos as agents move quickly

## Design Principles

### 1. Agent-first execution

The default assumption is that an AI agent can complete most scoped development work:

- read the repository
- understand the current constraints
- make changes
- document the changes
- run checks
- present results for review

Humans should not need to hand-hold the repository for routine engineering tasks.

### 2. Human-trackable progress

Even when agents move quickly, humans must be able to reconstruct:

- why a change happened
- what changed
- what constraints were followed
- how the change was validated

That is why the template emphasizes specs, change records, documentation standards, and conventional commits.

### 3. Strong guidance with explicit boundaries

Agents perform better when the repository provides clear operating rules. This template uses explicit constraints instead of relying on implicit team norms.

Examples:

- tests-first workflow
- required documentation standards
- conventional commits
- local app/package guides
- English-only code and docs

### 4. Fast context loading

The repository should help an agent get enough context quickly without reading the entire codebase. Documentation and directory structure should make the project legible in a few entry points rather than forcing deep exploration.

### 5. Polyglot by design

The template is intended for product and library development across multiple languages, with one repository containing both applications and shared packages. JS/TS-first at the root level, with cookbook-driven expansion paths for other languages when a repository actually needs them.

## Scope

This template is intended to support:

- frontend and backend product code
- shared libraries and reusable packages
- TypeScript or JavaScript workspaces as the default stack
- Python, Go, Rust, and Zig through cookbook-driven opt-in setup
- agent-driven implementation and multi-agent parallel work

## Non-goals

This template does not try to:

- prescribe a single product architecture for every team
- hide all engineering decisions behind automation
- replace human review or architectural ownership
- optimize for repositories where humans do most work manually
- provide every framework scaffold out of the box

It is a foundation, not a fully opinionated product stack.

## What The Template Should Provide

At a minimum, the template should provide:

- a clear repository structure for apps, packages, docs, and scripts
- explicit agent operating rules in `AGENTS.md`
- human contribution and review rules in `CONTRIBUTING.md`
- local `README.md` inside each important app and package
- optional local `AGENTS.md` only when an app or package has local agent execution rules
- a simple environment bootstrap path
- tracked git hooks and local validation that live in version-controlled files
- top-level tasks that provide stable build/test/lint/typecheck entry points
- shared build, test, lint, and format entry points
- curated change tracking through `docs/changes/`
- design/spec tracking through `docs/specs/`
- long-run release archives through `docs/working_logs/`
- reusable setup and operational guidance in `docs/cookbooks/`
- documentation that lets a new user understand the repository quickly

## Toolchain Policy

### JavaScript and package management

The default JavaScript path in this template is:

- Node.js as the default runtime
- pnpm as the default package manager
- pnpm workspaces as the default workspace model
- TypeScript as the default compiler for typed JS/TS projects
- Turborepo as the default build orchestrator
- Biome as the default linter and formatter

Bun is supported as an optional runtime for compatible packages and scripts, but it is not the default package manager for the repository. The root lockfile should remain `pnpm-lock.yaml` unless the repository makes an explicit architectural decision to switch.

### Optional language stacks

Python, Go, Rust, and Zig are not part of the root default toolchain.

They should be added through cookbook-driven setup when needed for a concrete repository.

### Version source of truth

Tool versions should not drift across files.

Rules:

- `.mise.toml` is the source of truth for managed tool versions
- root `package.json` must stay aligned with the default Node.js and pnpm policy
- documentation must reflect the current toolchain policy
- replacing a default tool is a template design change and should be documented here

## Setup Strategy

This template does not hardcode one fixed CI scaffold or one fixed sub-project scaffold.

Instead, setup guidance should live in `docs/cookbooks/` and be followed when relevant.

Rules:

- if a cookbook exists for the task, agents must follow it
- new sub-projects must be created with the appropriate CLI scaffolding tool, framework generator, or approved template
- agents must not invent a new sub-project by manually composing starter files unless a cookbook explicitly instructs that approach

## Repository Roles

### Human responsibilities

Humans remain responsible for:

- architecture
- risk acceptance
- business priorities
- review and merge decisions
- defining or refining ambiguous requirements

### Agent responsibilities

Agents are expected to:

- gather context before changing code
- follow repository constraints
- implement scoped tasks end-to-end
- add or update tests
- update documentation
- surface assumptions and risks clearly

## Documentation Model

The documentation should be easy to scan and each document should have a clear role.

- `README.md`: short top-level entry point and quick start
- `docs/template-overview.md`: template design, scope, and operating model
- `docs/cookbooks/`: setup and operational recipes used by agents
- `AGENTS.md`: concise execution rules for AI agents
- `CONTRIBUTING.md`: workflow and review rules for human contributors
- `docs/change-tracking.md`: repository policy for specs, change records, and working logs
- `docs/changes/`: curated records for material PR, standalone, or release-level context
- `docs/specs/`: design documents for non-trivial decisions
- `docs/working_logs/`: archived release PRDs, task lists, and progress logs

Inside each app and package:

- local `AGENTS.md`: agent-facing technical guidance
- local `README.md`: human-facing quick overview

Expected split:

- local `AGENTS.md`: tech details, constraints, command tips, caveats, and workflow notes for agents
- local `README.md`: purpose, scope, entry points, key commands, and usage for humans

## Quality Model

The template is built around repository quality that remains stable under heavy agent use.

Core quality mechanisms:

- TDD or failing-test-first development for behavior changes
- explicit documentation standards per language
- conventional commits
- versioned local hooks and staged-file validation
- high cohesion and low coupling
- local guidance close to the code
- focused files and modular structure
- repository-level JS/TS lint, format, build, test, and typecheck commands

## Multi-agent Collaboration Expectations

When multiple agents work at the same time, the repository should reduce collisions and ambiguity. The template should encourage:

- clear ownership by directory or module
- explicit specs for non-trivial work
- curated change records for material context
- local app/package guides for fast context loading
- consistent scripts and commands across packages
- small, reviewable commits

## How To Use This Template

### For a new repository

1. Review this document first to understand the intended operating model.
2. Review `README.md` for setup and command entry points.
3. Review `AGENTS.md` and `CONTRIBUTING.md` before making structural changes.
4. Check `docs/cookbooks/` before doing setup, CI work, or project scaffolding.
5. Customize the workspace structure, package names, and language modules for the new project.
6. Keep the core governance model unless there is a deliberate decision to change it.

### For day-to-day development

1. Follow `docs/change-tracking.md` before adding specs, change records, or working logs.
2. Write or update a spec in `docs/specs/` when the change is non-trivial.
3. Keep a curated change record in `docs/changes/` when material context should survive beyond the diff.
4. Keep local `README.md` current for affected apps/packages, and keep local `AGENTS.md` current when one exists.
5. Check `docs/cookbooks/` before setup or operational work.
6. Have agents implement work within the repository rules.
7. Validate with tests, linting, and formatting.
7. Let humans review outcomes, trade-offs, and risks.

## Current Compliance Status

As of the current template state:

- the repository root provides both `AGENTS.md` and `README.md`
- `apps/README.md` and `packages/README.md` define the local-guide rule for future sub-projects
- tracked hooks are managed by `lefthook`, with `lefthook.example.yml` promoted to `lefthook.yml` on first init
- `.mise.toml` exposes top-level tasks for the common repository commands
- `.github/workflows/ci.yml` provides a baseline CI workflow
- there are no concrete scaffolded app or package directories yet under `apps/*` or `packages/*`

That means the rule is documented and ready, and future sub-projects must implement it when they are created.

## Anti-drift Rules

To prevent the template from drifting over time, follow these rules when the template itself is updated:

1. If the template design, scope, workflow, or supported language/tooling model changes, update this document in the same change.
2. If agent execution rules change, update `AGENTS.md`.
3. If human workflow or review rules change, update `CONTRIBUTING.md`.
4. If setup or command entry points change, update `README.md`.
5. If setup workflow changes, update relevant cookbook documents in `docs/cookbooks/`.
6. If a document references files or commands that no longer exist, treat that as a defect and fix it immediately.

## Maintenance Checklist For Template Changes

When changing the template, verify:

- the overview in this document is still accurate
- setup instructions still match actual scripts and tools
- cookbook guidance still matches the intended setup workflow
- linked documents and paths exist
- command examples still run as written
- the documented workflow still matches repository policy

## Current Direction

The intended long-term direction of this template is:

- agent-friendly repository layout
- explicit rules instead of implied tribal knowledge
- Node.js, TypeScript, and pnpm as the default JS/TS path
- Bun as an optional runtime, not the default package manager
- polyglot support for product code and shared libraries
- cookbook-driven setup and operations
- local app/package guides for both agents and humans
- strong traceability for fast-moving agent work
- clean handoff between agent execution and human review

If future changes conflict with that direction, they should be treated as deliberate design changes and documented here rather than introduced implicitly.
