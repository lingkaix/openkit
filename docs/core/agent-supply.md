# Agent Supply

Status: Accepted

This document defines OpenKit agent supply semantics.

This document owns how OpenKit declares, discovers, resolves, explains, and prepares agent supply for Core scheduling.

This document does not own runtime continuity, capability-call routing, permission decisions, sandbox containment, complete config fields, native adapter config files, launch arguments, database tables, UI endpoints, or provider payloads.

It covers agent catalogs, agent setup contracts, profiles, capability summaries, readiness, and additive setup evolution.

## Purpose

OpenKit needs a stable way to describe what agents are available in a workspace, what supply they require, and how Core can initialize them.

The agent catalog is the discovery layer. Agent setup config is the declarative runtime setup contract. Runtime adapters may resolve and materialize that contract into native files, environment variables, process arguments, containers, sidecars, or provider sessions.

The supply model must stay open-ended because OpenKit will add agent fields over time for model routing, runtime selection, workspace inputs, MCP and skills, knowledge/context injection, vault references, sandbox policy, observability, and deployment modes.

## Principles

Agent supply is declared before it is materialized.

Agent catalogs are workspace-visible selection surfaces, not runtime launch manifests.

Agent setup contracts should describe required supply without embedding secret values, absolute local paths, provider-native payloads, or adapter-private launch details.

Runtime capability access belongs to `agent-capability.md`; agent supply may declare which capability categories an agent needs, but it does not own agent capability routing, gateway projection, or metering semantics.

Agent sessions materialize resolved supply into live or resumable runtime continuity; agent supply does not own session lifecycle.

## Scope

Agent supply is projected into a workspace-visible catalog by default.

A workspace may include:

- built-in agents
- user-installed agents
- server-owned agent setup config projected into the workspace catalog
- workspace-local setup entries when a future policy allows them
- organization-provided agents
- remote or managed agents in future versions
- disabled or unavailable agents kept for history and compatibility

Global, server-owned, or built-in agent setup sources may exist, but a workspace-visible catalog is the effective selection surface Core uses for routing work.

## Catalog Model

The conceptual catalog relationship is:

```text
Workspace
  AgentCatalog
    AgentCatalogEntry
      AgentSetupContract
        AgentProfile[]
```

`AgentCatalog` is the workspace-visible inventory.

`AgentCatalogEntry` is one selectable supply record.

`AgentSetupContract` is the declarative setup file or document referenced by the catalog entry.

`AgentProfile` is an optional setup-local behavior profile.

## AgentCatalog

`AgentCatalog` lets Core and product surfaces discover and explain available agent supply.

The catalog should answer:

- what agents exist
- which agents are enabled
- which agents are ready, degraded, blocked, or disabled
- which agent kind or role each agent has (planner, coder, researcher, reviewer, internal)
- which profiles or modes are available
- which capability categories are declared
- which agent is the default for common routing cases
- which setup version or setup snapshot produced the current summary

The catalog is a selection surface, not a complete runtime setup object.

## AgentCatalogEntry

`AgentCatalogEntry` is a compact discovery record.

It should expose enough information for selection, routing, readiness display, and explanation without embedding adapter-native config.

The protocol-level `AgentCatalogEntry` and `AgentSummary` records are summaries, not launch manifests.

They must not include adapter command lines, environment variables, absolute workspace paths, provider credentials, OAuth state, or runtime config payloads.

Note that "agent kind" on the catalog entry (`AgentCatalogEntry.kind`) is an agent role enum, not a runtime placement or backend kind. Runtime placement and backend kind stay in implementation manifests and are intentionally not projected onto the product-visible catalog entry.

Typical entry areas include:

- stable agent ID
- display name and description
- setup reference and version
- agent kind or role (`AgentCatalogEntry.kind` = planner, coder, researcher, reviewer, internal; this is the agent role, not a runtime kind)
- default profile or mode
- supported profiles or modes
- capability summary
- readiness summary
- sandbox summary
- permission summary
- resource summary
- status and diagnostics summary

These are catalog areas, not a closed field list.

## Agent Setup Contract

The agent setup contract is the declarative setup source used to initialize and operate one agent supply unit.

It may declare:

- identity and version
- runtime binding
- deployment options
- workspace input contract
- model and provider wiring
- MCP, tools, skills, and instruction supply
- setup-local profiles
- future knowledge references and injection hints
- future vault references and secret injection hints
- capability declarations
- permission and approval requirements
- sandbox expectations
- readiness requirements
- lifecycle hints
- resource limits
- observability declarations
- composition hints
- adapter extension namespaces

These are open catalog areas. This document intentionally does not enumerate all fields.

## AgentProfile

An `AgentProfile` is an optional setup-local profile for selecting behavior inside one agent setup contract.

Examples:

- default coder
- reviewer
- researcher
- planner
- browser operator
- test runner
- subagent
- handoff target
- tool-oriented agent

Profiles can declare or reference behavior-oriented settings such as instructions, model preference, skill list, capability subset, or routing hints.

Profiles are not standalone agents, top-level core objects, or protocol-level agent registries.

If setup config does not declare profiles, Core treats it as one implicit default behavior profile.

## Capability Catalog Areas

The catalog should summarize capability needs without authorizing them or routing capability calls.

Capability areas may include:

- LLM access
- MCP or tool access
- filesystem access
- shell access
- browser access
- network access
- knowledge read or write access
- vault reference use
- artifact production
- approval support
- interrupt support
- resume support
- long-running work support

Capability is separate from permission, sandbox, and agent capability routing. An agent can declare that it is capable of shell execution while permission policy denies shell use, sandbox policy prevents access to specific paths, and the agent capability gateway projection withholds external capability routes.

## Readiness

Readiness should not be a boolean.

Catalog and agent setup resolution should support common readiness states:

```text
ready
degraded
blocked
disabled
unknown
```

These five states are the internal resolution vocabulary used during agent setup resolution. The product-visible protocol `AgentCatalogEntry` does not carry this enum directly; it instead projects `health.status` (unknown, starting, ready, running, offline, failed) together with a separate `status` field (enabled, disabled).

Readiness should explain what was checked and what the user or system can do about failures.

Examples:

- runtime binary missing
- provider instance unresolved
- provider credential not granted
- MCP server unavailable
- workspace input missing
- sandbox backend unavailable
- adapter version incompatible
- setup schema version unsupported

## Resolution

Core may resolve agent setup through layers before starting an agent session.

Conceptual layers:

```text
built-in defaults
  -> server deployment policy
  -> provider registry
  -> workspace catalog
  -> authored agent setup config
  -> workspace or user overrides
  -> turn-specific routing hints
  -> late-bound vault, knowledge, and runtime values
```

The resolved result is used to initialize an agent session.

The exact `ResolvedAgentSetup` and `MaterializedAgentSetup` records are implementation details unless a future core revision promotes them. They may still be documented in specs for adapter implementation.

## Materialization

Materialization converts resolved setup into runtime-native form.

Examples:

- Codex config files
- Pi Agent launch flags
- OpenCode config files
- environment variables
- container image and volume mounts
- sidecar endpoints
- MCP server config
- sandbox provider payloads

Generated native files are outputs, not the canonical agent setup source.

Core should be able to explain which setup source and resolution inputs produced an agent session, even if the runtime-native materialization is adapter-specific.

## Extension Namespaces

Provider-native and adapter-native fields must live under explicit extension namespaces.

Unknown optional sections should be preserved or ignored by readers that do not understand them.

Required unknown sections must make the agent readiness `blocked` rather than being silently ignored.

Agent setup evolution should be additive by default.

## Invariants

- Agent catalogs MUST remain selection and explanation surfaces, not runtime launch manifests.
- Agent setup contracts MUST NOT embed secret values, absolute local paths, provider-native payloads, or adapter-private launch details as canonical fields.
- Agent supply MAY declare capability categories, but it MUST NOT own runtime capability routing, gateway projection, metering, permission decisions, or sandbox containment.
- Agent profiles MUST remain setup-local behavior profiles unless a future core design promotes a standalone concept.
- Generated native config files MUST remain materialization outputs, not the canonical agent setup source.

## Relationship To Other Docs

- `docs/core/core-concepts.md` owns canonical concept definitions.
- `docs/core/runtime-model.md` owns execution semantics.
- `docs/core/agent-session.md` owns runtime continuity.
- `docs/core/agent-capability.md` owns runtime capability access, gateway projection, routing, metering, and audit metadata.
- `docs/core/permissions.md` owns authorization.
- `docs/core/sandbox.md` owns execution isolation.
- `docs/core/knowledge.md` owns reusable knowledge and context injection.
