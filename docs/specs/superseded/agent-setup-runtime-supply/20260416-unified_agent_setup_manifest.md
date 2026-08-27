---
status: Superseded
implementation: N/A
status-changed: 2026-06-28
current-guidance: "`docs/core/agent-supply.md`, `docs/specs/20260616-agent_environment_package.md`, `docs/specs/20260703-agent_manifest_aep_resolution.md`, `docs/specs/20260704-session_static_workspace_materialization.md`, `docs/specs/20260629-worker_runtime_communication_model.md`"
decision-evidence: "`docs/core/agent-supply.md`, `docs/specs/20260616-agent_environment_package.md`, `docs/specs/20260703-agent_manifest_aep_resolution.md`, `docs/specs/20260704-session_static_workspace_materialization.md`, `docs/specs/20260629-worker_runtime_communication_model.md`"
---
# Unified Agent Setup Manifest

## Lifecycle Reason

The Agent Setup And Runtime Supply Contract consolidated manifest storage, resolution, package assembly, and runtime materialization under one active owner. This slice no longer has independent authority because retaining its parallel manifest contract would duplicate ownership and preserve earlier assumptions outside the consolidated boundary.

## Retention Reason

This document preserves the original unified-manifest field model, resolution sequence, and materialization constraints so maintainers can audit how the consolidated supply contract was derived without treating the earlier shape as current guidance.

This document is an implementation-layer spec for agent manifest storage, resolution, and materialization in `apps/nanocore`.

The stable core model lives in `docs/core/agent-supply.md`, `docs/core/runtime-model.md`, and `docs/core/agent-session.md`. This spec must follow those documents and must not redefine core concepts.

## Summary

This document proposes a repository-owned agent setup format for `apps/nanocore` that can describe models, skills, MCP servers, permissions, sub-agents, and runtime policy without making any agent-native config file the canonical source of truth.

The recommended design is a three-object model:

- `AgentManifest`: a durable, human-authored package definition stored in the workspace
- `ResolvedAgentSetup`: the fully merged, validated, adapter-ready setup produced at runtime
- `MaterializedAgentSetup`: the adapter-native files, env vars, and launch settings generated for
  one runtime target
`nanocore` should treat agent-native files such as `.codex/config.toml` as generated outputs, not as the primary configuration store.

## Goals / Non-goals

### Goals

- Define one canonical setup model that can work across Codex and future agent adapters.
- Keep `packages/protocol` product-shaped while allowing richer runtime setup inside
  `apps/nanocore`.
- Separate reusable package definitions from live runtime state and session snapshots.
- Support typed configuration for models, skills, MCP servers, sub-agents, permissions, and
  readiness checks.
- Allow adapter-specific materialization without leaking native config shapes into the repository's
  core design.
- Make effective setup inspectable and explainable.

### Non-goals

- Standardize all future agent runtimes on one external wire protocol.
- Expose raw adapter internals or provider secrets through `packages/protocol`.
- Implement the full setup API or UI in this iteration.
- Guarantee that every field is natively supported by every agent adapter.
- Replace existing workspace-visible `models`, `skills`, and `agents` in the product contract.

## Background

`apps/nanocore` now has a real Codex host adapter, but session startup is still hardcoded around one `thread/start` flow and one fixed process shape. The repository already distinguishes product-visible workspace resources from runtime adapter internals:

- `packages/protocol` owns user-visible agents, models, skills, defaults, and lifecycle records
- `apps/nanocore` owns the internal `Core <-> Agent` runtime contract

The missing piece is a durable runtime setup model for agent bootstrapping. The current need is immediate for Codex because startup configuration may include native files such as `.codex/config.toml`, but the design should not assume that future runtimes use the same files, properties, or packaging boundaries.

Research across OpenFang, OpenCode, OpenClaw, and IronClaw suggests six recurring lessons:

1. Keep one canonical control-plane authority for setup.
2. Separate packaged manifests from resolved runtime setup.
3. Layer config by lifecycle and scope instead of storing one flat blob.
4. Keep shared registries for models and connectors separate from per-agent assignment.
5. Make readiness and effective config inspectable.
6. Snapshot the resolved setup used by an agent session or turn.

## Proposed design

### 1. Canonical objects

The runtime should introduce three distinct setup-stage objects:

- `AgentManifest`: a durable package definition authored in the workspace
- `ResolvedAgentSetup`: the merged, validated setup produced from manifest plus overrides
- `MaterializedAgentSetup`: the adapter-native files, env vars, and launch arguments emitted for a
  specific runtime target

This follows the same split seen in OpenFang Hands and IronClaw profiles:

- manifest definition is stable and reusable
- resolved setup is runtime-owned and inspectable
- native outputs are generated artifacts

### 2. Storage layout

The canonical repository-owned setup root should live under `.openkit/` rather than under a runtime-native folder such as `.codex/`.

Recommended layout:

```text
.openkit/
  models/
    default.toml
    gpt-5-4.toml
  mcp/
    github.toml
    playwright.toml
  skills/
    repo-guidelines/
      SKILL.md
      skill.toml
  agents/
    codex-coder/
      agent.toml
      prompt.md
      subagents/
        research.md
        review.md
```

Why this shape:

- `models/`, `mcp/`, and `skills/` become reusable registries
- `agents/<id>/agent.toml` becomes the manifest entry point
- prompt and sub-agent prompt files stay readable Markdown instead of bloating one config blob
- generated adapter-native files can be written to temp/runtime directories without polluting the
  source tree

### 3. Canonical file format

Use TOML for the canonical manifest files.

Reasons:

- Codex, OpenFang, and IronClaw all demonstrate that TOML works well for typed runtime config
- it is easier to hand-author and review than JSON for nested settings
- it supports clean sectioned config while keeping comments available
- it is a better fit than reusing an agent-native format because the repository needs its own
  stable schema

Markdown files remain the right place for long instructions and sub-agent prompts.

### 4. Bundle schema

Each `agent.toml` should define the durable agent manifest. The schema should be repository-owned and versioned.

Illustrative shape:

```toml
schema_version = 1
id = "codex_coder"
runtime = "codex"
kind = "coder"
extends = ["base/coder"]

[identity]
name = "Codex Coder"
description = "Primary implementation agent for local code tasks."

[model]
profile = "default"
fallback_profiles = ["gpt-5-4"]
reasoning_effort = "high"

[execution]
approval_policy = "never"
sandbox = "danger-full-access"
cwd = "."
profile = "host-local"

[instructions]
prompt_file = "./prompt.md"
skill_ids = ["repo-guidelines"]

[visibility]
mcp_server_ids = ["github", "playwright"]

[subagents.defaults]
enabled = true
inherit = ["model", "execution", "visibility"]

[[subagents.entries]]
id = "research"
description = "Deep research helper"
prompt_file = "./subagents/research.md"
skill_ids = ["repo-guidelines"]
model_profile = "gpt-5-4"

[[requirements]]
id = "codex-login"
kind = "command"
command = ["codex", "login", "--check"]
severity = "blocking"
```

Expected field groups:

- metadata: `schema_version`, `id`, `runtime`, `kind`, `extends`
- identity: stable package identity and display data
- model policy: default profile, fallbacks, reasoning, optional runtime hints
- execution policy: sandbox, approval, cwd, env policy, runtime preset
- instructions: prompt file, skill references, optional inline instruction fragments
- visibility: connector allowlists and tool exposure policy
- sub-agents: named delegated roles with inheritance and overrides
- requirements: readiness checks, missing dependency hints, degraded-mode metadata
- adapter extras: explicit, namespaced escape hatch for runtime-specific fields

### 5. Separate registries from assignment

Models, MCP servers, and reusable skills should not be duplicated into every agent manifest.

Recommended split:

- `.openkit/models/*.toml` defines model profiles and provider details
- `.openkit/mcp/*.toml` defines reusable MCP server entries
- `.openkit/skills/*` defines reusable skill packages or references
- `agent.toml` references those registries by stable ID

This follows the best part of OpenFang and OpenCode:

- global or workspace registries own reusable connector and model definitions
- each agent manifest declares what it wants to use or expose

### 6. Layered resolution

The runtime should resolve agent setup through explicit layers:

1. built-in adapter defaults
2. deployment profile or environment preset
3. workspace registries under `.openkit/`
4. agent manifest definition
5. workspace or user overrides
6. per-session inline overrides
7. injected secrets and late-bound runtime values

The output is `ResolvedAgentSetup`.

This object should include:

- effective fields after merge
- origin metadata for each overridden block when practical
- warnings for unsupported or ignored fields
- computed readiness state
- monotonic `setupVersion` or content hash for snapshotting

### 7. Readiness model

The runtime should not reduce setup to `configured: true|false`.

Borrowing from OpenClaw, readiness should be structured:

- `ready`
- `degraded`
- `blocked`
- `disabled`

Each requirement should explain:

- what was checked
- whether the failure blocks startup or only downgrades capability
- how to fix it
- which agent fields are affected

Examples:

- `codex` binary missing
- login/session missing
- MCP server command missing
- model profile unresolved
- sub-agent prompt file missing
- adapter does not support a requested section

### 8. Materialization contract

Every adapter should implement a small materialization boundary:

- input: `ResolvedAgentSetup`
- output: `MaterializedAgentSetup`

`MaterializedAgentSetup` contains:

- temp/runtime directory path
- generated files
- environment variables
- command arguments
- capability warnings

For Codex, this likely includes generated native assets such as:

- `.codex/config.toml`
- prompt or instruction files when required
- adapter-owned env vars and launch args

The important rule is that the generated `.codex/` tree is disposable output. Editing those files should not be the normal authoring workflow.

### 9. Sub-agent model

Sub-agents should be first-class in the canonical schema rather than hidden inside runtime-specific blobs.

Each sub-agent entry should support:

- stable `id`
- display name and description
- prompt file
- model profile override
- skill references
- MCP visibility override
- execution-policy override
- enabled or disabled status

The base manifest should define inheritance rules so common setup does not need duplication. This is the cleanest way to represent differences between runtime-native sub-agent formats while preserving one repository-owned model.

### 10. Boundary with `packages/protocol`

The canonical agent setup manifest belongs to `apps/nanocore` runtime design, not to the `UI <-> Core` product contract.

The protocol should continue exposing product-visible abstractions such as:

- workspace agents
- workspace models
- workspace skills
- defaults

The runtime manifest may later inform those objects, but raw setup manifests, provider secrets, and adapter-native materialization details should stay internal to the server.

## Alternatives considered

### Alternative A: Store agent-native config files as the canonical source

Example: author `.codex/config.toml` directly and add wrapper metadata around it.

Why not:

- does not generalize across runtimes
- leaks adapter-native shapes into repository design
- makes inspection and UI support harder because each adapter needs custom parsing
- turns migration between runtimes into manual file translation

### Alternative B: Reuse workspace product resources as the full runtime config source

Example: make `agents`, `models`, and `skills` in `packages/protocol` carry all runtime setup.

Why not:

- violates the current repository boundary that keeps adapter internals out of the product contract
- encourages raw provider and runtime config to leak into UI-facing payloads
- makes the product model heavier before the runtime model is stable

### Alternative C: Use one flat `agent.json` per agent

Why not:

- simpler initially, but becomes hard to share model and connector definitions cleanly
- encourages duplication across agents
- makes layered origin and readiness harder to explain

## Rollout / Migration plan

1. Finalize this design and confirm the storage root and naming.
2. Add internal TypeScript types for `AgentManifest`, `ResolvedAgentSetup`, `MaterializedAgentSetup`,
   `ModelProfile`, `McpServerProfile`, `SubagentProfile`, and `RequirementStatus`.
3. Build a resolver that loads `.openkit/` registries plus one agent manifest and produces a
   validated `ResolvedAgentSetup`.
4. Implement Codex materialization that emits a temp runtime directory and adapter launch config
   from that resolved object.
5. Replace hardcoded Codex startup values in `apps/nanocore/src/runtime/host-adapter.ts` with the
   resolver plus materializer output.
6. Later, decide which parts of resolved setup should become readable through `nanocore` APIs.

## Testing strategy

- Unit tests for manifest parsing and schema-version validation.
- Unit tests for layered merge behavior and inheritance.
- Unit tests for readiness checks and unsupported-field warnings.
- Unit tests for sub-agent inheritance and override resolution.
- Integration tests for Codex materialization from a sample `.openkit/agents/...` manifest.
- Regression tests to confirm the existing host adapter still starts sessions correctly from
  generated setup.

## Risks & mitigations

### Risk: The schema becomes a second agent framework

Mitigation: keep the canonical schema small, typed, and focused on setup. Do not absorb full task or conversation semantics.

### Risk: Layered config becomes opaque

Mitigation: make `ResolvedAgentSetup` inspectable, track origin metadata, and surface readiness plus warnings.

### Risk: Agent manifests drift too far from runtime-native capabilities

Mitigation: adapters must emit explicit unsupported-field warnings instead of silently dropping config.

### Risk: Global registries create hidden coupling across agents

Mitigation: keep registries ID-based, explicit, and snapshot the resolved config used at run time.

### Risk: Codex needs native details not captured in the first schema

Mitigation: include a small namespaced adapter-extension block and evolve the repository-owned schema version deliberately.

## Open questions

- Should the workspace root be `.openkit/` or a narrower runtime-specific path such as
  `.openkit/runtime/`?
- Should agent manifests support remote references or only local filesystem content in the first
  iteration?
- Which fields need explicit provenance tracking in the first version: all fields or only top-level
  sections?
- Which resolved setup details should be exposed through future API or debug endpoints?
- How much Codex-native structure should be materialized as files versus launch arguments or env
  vars in the first adapter implementation?

## Decisions Locked In (2026-05-13)

These constraints are fixed in design discussion and informed by external source review of OpenAI Agents SDK Sandboxes, OpenFang `agent.toml` versus `HAND.toml`, multica's `Backend` shape, MCP config materialization, and frozen-argument handling. Update this section, not the prose above, when revising.

### D1. Manifest absorbs the OpenFang `HAND.toml` super-structure

The manifest is not just a low-level agent definition. It is an agent manifest plus requirements, settings, dashboard declarations, composition hints, lifecycle hints, and resource limits in the spirit of the OpenFang `HAND.toml` shape. New top-level sections to add to the canonical schema (alongside the existing §4 ones):

- `[[requires]]` — host/container prerequisites with platform-specific install hints (`macos`, `windows`, `linux_apt`, `linux_dnf`, `linux_pacman`, `manual_url`, `estimated_time`). Resolver runs them at session start in `host` mode and at image-build time in `local`/`remote` modes. Install commands are surfaced as copy-pasteable hints; never auto-executed.
- `[[settings]]` — user-tunable knobs with UI metadata (`key`, `label`, `description`, `setting_type`, `default`, optional `[[settings.options]]`). Resolved per `(workspace, thread)` scope. The UI renders the settings page from this metadata; nothing about settings is hardcoded in the UI.
- `[observability.dashboard]` `[[observability.dashboard.metrics]]` — manifest declares which audit/usage fields surface in the dashboard, bound by source path (`audit.usage.tokens.last_hour`, `audit.lifecycle.turns_completed`, etc.). UI dashboards become a pure data binding.
- `[composition]` — declares whether the agent can be a handoff target (`can_be_handed_off_to`) and / or an agent-as-tool target (`can_be_invoked_as_tool`). Mirrors the OpenAI Agents SDK distinction. See [20260416-host_agent_adapter.md](../../superseded/worker-runtime/20260416-host_agent_adapter.md) §D4.
- `[lifecycle]` — `init_timeout_secs`, `turn_timeout_secs`, `heartbeat_interval_secs`, `interrupt_grace_secs`, `suspend_on_idle_secs`, `persist_session_state`. Long-tail tuning that has historically been hardcoded inside adapters. Persist-state enables OpenFang-style `Running → Suspended → Terminated` recovery across host restarts.
- `[resources]` — `max_llm_tokens_per_hour`, `max_concurrent_tools`, `max_iterations_per_turn`. Hard scheduler quotas; enforced by Core's metering layer.

### D2. Workspace declaration uses the OpenAI Sandboxes input vocabulary

The `[workspace]` section uses the OpenAI `Manifest` input vocabulary, with paths workspace-relative and `..` escapes forbidden:

```toml
[[workspace.inputs]]
kind = "git_repo"   # one of: file | dir | local | git_repo | s3_mount | gcs_mount | r2_mount | azure_blob_mount
url = "${USER_SOURCE_GIT_URL}"
target = "repo/"                     # workspace-relative; resolver rejects absolute paths
snapshot_policy = "materialized"     # one of: materialized | ephemeral

[[workspace.inputs]]
kind = "s3_mount"
bucket = "${ORG_DATAROOM_BUCKET}"
target = "data/"
snapshot_policy = "ephemeral"        # mounts are excluded from snapshots, per OpenAI rule

[[workspace.users]]
name = "agent"
groups = ["agent"]

[environment]
PYTHONUNBUFFERED = "1"
[environment.ephemeral]              # rebuilt each session, not persisted
DISPLAY = ":99"
```

Resolver enforces: no absolute paths, no `..`, no overlapping target paths. Snapshot/persistence flows skip `ephemeral` entries (matches OpenAI's "snapshot and persistence flows skip mounted remote storage" rule).

### D3. Capability section carries explicit MCP modes and OS allowlists

`[capabilities.mcp]` entries declare which of the **three MCP modes** they use:

- `bridge.spawned` — `openkit-bridge` (or in-process Core in `host` mode) spawns the MCP server; multiplexed across agent sessions; vault credentials available.
- `bridge.remote` — bridge proxies to an external MCP HTTP/WS endpoint; vault credentials available.
- `agent.local` — the MCP server runs **inside the agent execution domain** (same container/host) via a local CLI. For MCPs that need agent-local resources (Playwright, chromium-mcp, filesystem-mcp, anything that touches the agent's `cwd` / browser session / display). Materializer writes the entry directly into the agent's `--mcp-config` (or equivalent file) as a `command`/`stdio` MCP, not as a bridge URL. **Validator rule: `agent.local` entries cannot declare credential refs**, because the agent is not allowed to hold vault credentials.

```toml
[[capabilities.mcp]]
id = "github"
mode = "bridge.spawned"

[[capabilities.mcp]]
id = "playwright"
mode = "agent.local"
command = "npx"
args = ["@playwright/mcp@latest"]
```

OS-level capability allowlists adopt the OpenFang shape (glob lists, not booleans):

```toml
[capabilities.os]
shell = ["cargo *", "rustc *", "git *", "npm *"]
network = ["*"]                              # bridge/proxy enforces real boundary
memory_read = ["self.*", "shared.read.*"]
memory_write = ["self.*"]
```

### D4. Credentials are references, never inline values

The manifest never holds secret values. Credentials appear as vault references resolved by the bridge transformer pipeline (see [20260507-codex_agent_communication_modes.md](../worker-runtime/20260507-codex_agent_communication_modes.md) §6 transformer slot):

```toml
[[credentials]]
ref = "vault://github/pat"
inject_as = "env:GITHUB_TOKEN"
ephemeral = true                     # rebuilt each session, not persisted
```

Validator rule: any `credentials` entry attached to a `agent.local` MCP is rejected; vault credentials only flow to bridge-mediated capabilities.

### D5. `frozen_args` resolver semantics

§6 resolver step 4 ("agent manifest definition") merges `[runtime.user_args.custom]` with the adapter-owned `FrozenArg` set declared in adapter code (see [20260416-host_agent_adapter.md](../../superseded/worker-runtime/20260416-host_agent_adapter.md) §D3). Conflicts produce a `ManifestError` with the citation `runtime.frozen_args_doc` so the user can see which adapter rule rejected their override. The resolver never silently drops or appends a conflicting flag. The `[runtime.frozen_args_doc]` block in the manifest is documentation only; truth lives in adapter code.

### D6. Agent definition vs deployment shape stay separated

The manifest carries three layered concerns:

- **Identity + runtime** (`[agent]`, `[runtime]`): what this agent IS. Adapter, version, kind. Mode-agnostic.
- **Deployment** (`[deployment]`, `[deployment.host]`, `[deployment.local]`, `[deployment.remote]`): how to launch in each mode. Only the mode-specific block is consumed per resolution.
- **Capability + lifecycle + resources + observability**: how it operates once running. Mode-agnostic.

This split is the structural payoff of "mode-agnostic agent + host adapter absorbs variation" from [20260507-codex_agent_communication_modes.md](../worker-runtime/20260507-codex_agent_communication_modes.md).

### D7. Skills materialize as Markdown files at session start

Per the multi-agent CLI patterns research, every observed harness ships skills as Markdown files dropped into the agent's working directory (`AGENTS.md`, `CLAUDE.md`, `SKILL.md`, `GEMINI.md`, etc.). `.openkit/skills/` remains the authoritative source; the materializer per-runtime writes the appropriate file name into `cwd` at session start. The manifest's `instructions.skill_ids` list is preserved as authoritative provenance for audit; the materialized files are disposable output.
