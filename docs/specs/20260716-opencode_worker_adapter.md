---
status: Accepted
kind: boundary
implementation: Partial
aspect: agent-session
---

# OpenCode Worker Adapter

This specification owns the OpenCode 2.2.5 delta. Shared adapter rules live in [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md).

## Scope

Owns the OpenCode V2 server mapping, its private handle, and its host plugin.

Does not own:

- The shared adapter base. [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md) owns it.
- Private Harness operations. [Worker Control Protocol](20260703-worker_control_protocol.md) owns them.
- The image. [Worker Execution Environment Images](20260721-worker_execution_environment_images.md) owns it.
- Public live steer. [Task Mode](20260704-task_mode_worker_delegation.md) owns it.
- Native volume placement. [Persistent Worker Volumes](20260910-persistent_worker_volumes.md) owns it.

Core: [AgentSession](../core/agent-session.md), [Sandbox](../core/sandbox.md).

## Runtime

The pin uses the OpenCode V2 CLI and `@opencode/client` at 2.2.5, one supervised Sandbox server, and no `opencode run`, ACP, embedded SDK, or extra IPC interface ([four native runtime adapters](../decisions/20260929-four_native_runtime_adapters.md)). The image deploys the glibc Linux arm64 and x64 CLI and client on the shim resolution path, the generic shim entrypoint, and a non-root user. The Effect graph stays out of `worker-common`.

## Launch And Session Mapping

Sharing, updates, model fetch, the default plugin, and the LSP download are disabled. The image keeps the overriding system-config source absent, or proves equivalent protection. A runtime plugin rewrite stays outside support.

The final whole protected provider and MCP entries, and the mandatory host plugin, win without editing authored files. A collision warning follows [Adapter Base Contract](20260629-worker_runtime_communication_model.md#adapter-base-contract). The plugin lends the bearer only to the exact adapter-created loopback target.

Open creates or resumes the exact session. The handle stays pending until a read-only `session_v2` row proves it. Each ready inspection rechecks the live exact identity, time, and closed outcomes around the RPC.

The retained reference is the exact `v1:`-prefixed session id. A successor resumes the same conversation, with a new MCP schema and the prior context, and makes no idle capability contact.

### Reasoning Effort Delivery

`session.switchModel` selects and verifies the declared model against the seven exact `reasoningEffort` variants before the prompt. An unchanged model with omitted effort keeps the current variant. A model change with omitted effort supplies `none`.

The first Turn supplies the working directory, Skill targets, MCP ids, and the exact available-model catalog. `location.reload` and `location.move` initialize services before catalog proof. A changed set refuses before a native request.

Only an absent native home is initialized, through validated sibling staging. Unreadable, escaping, or leftover staging refuses. An existing home is reused with no source merge. Native home and project resources stay effective.

`experimental.mcp.add` and `experimental.mcp.connect` use protocol `2026-07-28` for the exact managed ids. The adapter waits for location-specific plugin generation and the native move drain before the prompt.

Native provider and model serialization is fixed and slash-free, and the base URL is loopback. Ephemeral host-plugin carriers apply the exact current inference and capability bearer. They never use a native stored fallback or a secret in configuration text.

Native `tool_output.max_lines`, `tool_output.max_bytes`, and `media.image` resizing keep native spill and truncation. There is no V1 key compatibility.

Cancel acknowledgement is a boolean, correlated with the terminal outcome. A completed or failed race survives cancellation. One stop owner bounds the wait. The joining remainder follows [Errors And Failure](20260629-worker_runtime_communication_model.md#errors-and-failure).

### Live Steer Mapping And Qualification

This pin has no expected-execution guard. Idle `delivery:steer` can start new work. The adapter exposes no steer hook and refuses without native effects.

## Event Mapping

### Native Output Mapping

The adapter correlates the admitted user anchor with exactly one ordered idle boundary and the native session outcome. Stop and length are closed alternatives. A later unrelated user, a partial result, or a native error cannot establish success ([Truthful Native Stop Classification](../decisions/20261009-truthful_native_stop_classification.md)).

Unknown additive events are ignored. Native message, provider, and session objects stay local. Malformed authority or terminal evidence fails. There is no latest-assistant shortcut.

Pages are read descending to the exact admitted user anchor and then reversed. The ceiling is 20 pages. The cursor core is strict. Ids are unique across the complete fetched pages, including older rows on the anchor page.

A prompt that may have been accepted stays an accepted failed settlement after a proved stop. It is not a clean refusal. A settled old Turn cannot cancel new work. An unproved stop keeps the fences.

Structural sink preparation and finalization follow [Adapter Base Contract](20260629-worker_runtime_communication_model.md#adapter-base-contract). An incomplete report stays cleanup-bounded.

Current-result UTF-8 text, reasoning, Tool payload, and envelope bytes are counted independently before concatenation. Selected assistant text is capped separately at 16 MiB. Prior history and pre-prompt history do not consume this result budget.

## Deviations From The Base Contract

`serve --stdio` on this pin installs no automatic restart-recovery sweep. Any pin or mode change is requalified against pending MCP effects and retained Tool and endpoint evidence.

An auxiliary native title inference may carry its own selected effort under AEP per-request precedence. One model request per Turn is not assumed.

Before the next prompt, the adapter revalidates the published immediately preceding Turn's anchor-to-head terminal evidence. It does not certify all older history, and a fresh binding has no baseline to certify.

Idle close is a normal stdio EOF, finalizers, a zero exit, child close, and both output EOFs, without error. A forced exit or an active close cannot supply flush proof. A pre-prompt refusal uses the same graceful path.

No narrower download-disable is available. `lsp: false` is the disablement, and the file watcher remains available. Parser limits and generated native tool limits are distinct.

## Unsupported Operations

Every unsupported or direct-provider route is rejected before work. The adapter does not invent a fallback.

A residual permission ask is allowed once through the supported hook and reply. A typed-answer form is cancelled. An unproved refusal drain stops the host. Authored denies stay.

## Acceptance

General, MCP, and producer truncation, image omission, spill retrieval, and cleanup are qualified under this pin, separately from the product raw-output meter.

A future steer mapping proves native same-Turn inbox acceptance, the exact initial and steering user lineage, idle-race closure, and no restart or successor spill. It adds no custom queue and no prompt after abort.

## Implementation

- `packages/worker-shim/`
- `containers/worker-runtimes/`

## Implementation Gaps

- A future steer mapping proves native same-Turn inbox acceptance, the exact initial and steering user lineage, idle-race closure, and no restart or successor spill - On main, 2.2.5 has no qualified steer hook - #771

## Decisions

- [Four native runtime adapters](../decisions/20260929-four_native_runtime_adapters.md)
- [Earlier-version data](../decisions/20260930-earlier_version_data_not_carried.md)
- [Sandbox full-capability rulings](../decisions/20261001-sandbox_full_capability_rulings.md)
- [Truthful native stop classification](../decisions/20261009-truthful_native_stop_classification.md)
- [Worker runtimes upgrade](../decisions/20261031-worker_runtimes_upgrade_to_latest.md)
