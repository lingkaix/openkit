---
status: Accepted
kind: boundary
implementation: Partial
aspect: agent-session
---

# Pi Worker Adapter

This specification owns the Pi 1.5.2 SDK delta. Shared adapter rules live in [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md).

## Scope

Owns the dedicated Pi SDK host, its private channel, and search-only native MCP.

Does not own:

- The shared adapter base. [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md) owns it.
- Private Harness operations. [Worker Control Protocol](20260703-worker_control_protocol.md) owns them.
- The image. [Worker Execution Environment Images](20260721-worker_execution_environment_images.md) owns it.
- Public live steer. [Task Mode](20260704-task_mode_worker_delegation.md) owns it.
- Gateway model routing. [Gateway tier routing](../decisions/20261001-gateway_tier_routing_rulings.md) owns it.

Core: [AgentSession](../core/agent-session.md), [Sandbox](../core/sandbox.md).

## Runtime

The pin uses the official Pi SDK 1.5.2 in a dedicated private-channel host, with the matched `pi-ai`, `pi-tui`, and `pi-mcp` closure and the required workspace patch. The shim and `worker-common` stage contain no Pi dependency. There is no JSON, RPC, or ACP interface ([four native runtime adapters](../decisions/20260929-four_native_runtime_adapters.md)). Gateway `pi-ai` stays separately pinned at 0.99.2.

The image deploys the workspace-patched native MCP `onConnectionState` plus the matched private loader and default transport imports. A plain npm Pi install is not equivalent. Required managed connection and tool registration gate provider work, including pending transports.

## Launch And Session Mapping

The native trusted-project loader loads settings, packages, Extensions, Skills, templates, context, and local MCP inside the admitted roots. Browser and tool environment reach the headless host. The host does not hardcode a restrictive OpenKit tool list.

Complete protected model, MCP, and required-resource bindings apply last. Collision warnings and unchanged files follow [Adapter Base Contract](20260629-worker_runtime_communication_model.md#adapter-base-contract). A selected Skill replaces a same-name native Skill. The actual effective required MCP, search factory, and connection owner cannot be displaced.

`session.open` spawns the private host only and proves the exact resume header before spawn. The first bound Turn opens the SDK with the working directory, model, and MCP, creates or resumes the exact session, and then prompts. There is no idle capability contact.

The private handle JSON is the exact ordered encoding of cwd, path, and session id. Core hashes those encoded bytes. The parser verifies the exact encoding, containment, and header. It adds no discovery authority.

### Reasoning Effort Delivery

The admitted model is configured through the SDK, and `setThinkingLevel` runs before the prompt. The native off codec follows [Adapter Base Contract](20260629-worker_runtime_communication_model.md#adapter-base-contract). There is no global-default mutation. Presence of the reasoning-effort field enables native reasoning, `supportsReasoningEffort`, and the OpenAI thinking format. Dummy cost fields are zero and are not billing evidence.

### Live Steer Mapping And Qualification

Pin 1.4.0 steer uses resident `AgentSession.steer` and the active generation, Item, and digest. Handled-without-native-admission is definite nondelivery. The pending native queue is cleared at terminal, abort, or fence, and is never retained history.

Search adds a genuine `createToolSearchExtension` beside `createMcpExtension`. No `codemode` composer is supplied. `tool_search` is activated through the public active-tool API before provider work, without dropping native or direct tools. The search default covers `codemode`, `codemode-deferred`, and `deferred` tools, and preserves user exposure. Hidden tools are never loaded. The exact registered native target executes. Managed tools stay direct, and search adds no connection ([Pi native MCP discovery](../decisions/20260930-pi_native_mcp_discovery.md)).

Native configuration is inspected at connection time, including Extension-authored entries. The adapter replaces a whole admitted disabled, stdio, or native entry. It does not inherit transport or credential residue. A factory failure is a setup failure. An empty catalog is ready.

Both loopback values are redacted before native conversion, logging, and persistence, including reflected content, resources, and errors. Cancellation closes pending and connected MCP transports. One owner exists per server.

The whole effective catalog refuses distinct server names that share a normalized namespace, in either order, including Extension, managed, and native combinations. A tool-name collision uses the native hash suffix and exact original dispatch.

The native in-memory `openai-completions` descriptor is built from the current AEP: a fixed provider alias and loopback, the exact bounds and modalities, and zero native cost metadata. Supported text and image projection follows [Adapter Base Contract](20260629-worker_runtime_communication_model.md#adapter-base-contract). It carries no secret, caller JSON, project-resolver merge, or retained model catalog. The in-memory SDK runtime API-key store and the managed MCP Authorization header carry the exact loopback credentials. A native auth store, an old environment variable, or another binding is never a fallback.

Only an absent native agent directory is initialized, by validated staging. There is no independent system layer, refresh, or merge. A populated directory and an exact successor preserve the bytes.

`PI_OFFLINE` is `1`, `PI_SKIP_VERSION_CHECK` is `1`, and `PI_TELEMETRY` is `0`, with the admitted agent directory. There is no native package install or update. Installed resources still load.

Pi SDK 1.4.0 native handled/accepted intake and its volatile pending queue do not establish consumption. Qualify receiver read-back that identifies the original Item and generation while processing on the exact Turn, including two identical texts, ACK loss, queue loss, abort and a successor racing a stale steer. Treat unproved processing as unknown. Refuse paths whose required safe boundary cannot qualify before contact. Preserve input at the work owner through read-back or governed resolution. [Retained Delivery Proof](20260703-worker_control_protocol.md#retained-delivery-proof) owns the shared boundary.

## Event Mapping

### Native Output Mapping

The SDK terminal tracker matches the admitted provider and model and the assistant, turn, agent, and `agent_settled` correlation. A retry, a tool use, an intermediate end, or contradictory evidence cannot claim success ([Truthful Native Stop Classification](../decisions/20261009-truthful_native_stop_classification.md)).

Settlement is published at the correlated `agent_settled` without waiting for `prompt()` to return. Pending prompt cleanup blocks later model changes and prompts.

The private protocol channel is separate from stdout and stderr logs. Diagnostics are only the addressed Turn's logs and warnings. Host close also requires all three channel EOFs and a validated buffered tail.

A correlated native inference error is private `pi-inference-failed`. A route mismatch, malformed evidence, or unmatched evidence stays a correlation failure. The host and the reader share that closed reason vocabulary. It is not a new Core stop reason ([worker failure rulings](../decisions/20261015-worker_failure_final_and_chat_call_rulings.md)).

Structural capture follows [Adapter Base Contract](20260629-worker_runtime_communication_model.md#adapter-base-contract) for content off and on. This pin forwards the current primary assistant and tool phases. There is no attributable child source, so child coverage is unsupported. Reasoning and native envelopes are excluded.

## Deviations From The Base Contract

The restricted exact session file is contained, nonempty, and not a symlink, and it has the correct id, cwd, and header. The same admitted path, header, and cwd are the proof. There is no inode or history tracker. A failed Turn never creates a new ready authority.

Explicit text is concatenated in native order without separators, trimmed once, and required to be nonempty. A successful empty assistant is a failure on this pin.

Native MCP stays on protocol `2025-11-25` because pinned `pi-mcp` supports that set.

On the host-managed `openkit-work` server, Pi gives the `knowledge_ask` and `knowledge_tell` native call timer and HTTP response wait the default Knowledge Manager deadline plus 15 seconds for admission and settlement. Those HTTP requests use both the native call and session cancellation signals. Pi's ordinary MCP timeouts apply to other calls and setup. A custom Knowledge Manager profile can exceed this wait.

Startup selects the current native settings and defaults, with builtin suppression and additive modifiers. It does not load a retained transcript loadout. Registrations are preserved. There is no custom merge, reset, or eager rediscovery. Resident Turns keep activation.

An exact successor rebuilds the current native and direct-plus-search selection. A previously searched inactive tool returns native unavailable with zero effect. An eligible tool may be searched again. It is never replayed, retried, or restored from history.

Required host Extensions cannot be replaced, and local catalog presence gives them no authority. Admitted roots and external managed supply stay separate. Native tool search is not a managed MCP re-list.

Native head-read, tail-shell, spill, and image behavior, and a permitted user context mode, are preserved. OpenKit neither ships nor depends on context-mode, and it does not force a native Tool rewrite.

This pin has no retained-history barrier and no last-Turn comparison. Exact file and header identity, plus an acknowledged host close, are its local predicate.

## Unsupported Operations

Headless confirmation returns true, and the deny-capable boolean path stays. Free-form, select, editor, and custom prompts return undefined. UI-only panels and shortcuts are unsupported and diagnostic only.

The shared image carries no retired direct Anthropic bootstrap carrier, and the launcher does not inherit that direct credential.

## Acceptance

Search acceptance verifies the first provider-visible genuine search plus unrelated current authored or default tools. A successor uses the current defaults and refuses a singleton or a history-union substitute.

Search acceptance executes all three exposure modes through real local servers and the provider path from search to schema to the exact direct call, and it asserts the target count and arguments.

Search acceptance verifies managed direct tools before search, no duplicate client or registration, hidden non-discovery and non-invocation, an unchanged source config, and a ready empty catalog.

Wrong-target acceptance proves hashed colliding tool names in both orders, zero calls to the other target, and a whole setup refusal for colliding server namespaces. There is no fallback script and no config rename.

Search acceptance proves independent host builtin restoration and full managed transport precedence across user, project, Extension, disabled, and stdio entries. A failing or pending init stays unready.

Search acceptance proves argument hooks, current revocation, and reflected-secret redaction. Native search grants no new Provider, Gateway, or egress authority.

Native capability acceptance exercises an authored `codemode` setup plus observable shell and file writes and ordinary namespaced and direct MCP, without weakening containment or cancel obligations.

Lifecycle acceptance proves resident activation, exact successor identity, prefix, and current startup selection, a zero-effect stale call and then one new searched effect, no restoration of hidden, withdrawn, or revoked tools, and pending and connected cleanup.

A user `codemode` setup may load. Advertising script composition requires the released upstream fix, the carried patch, and exact-target, asset, credential, cancel, continuity, and image-result qualification. Closing an upstream issue, an import, or an arithmetic check is not that proof.

If a script or image result path is enabled, the pinned image-validation defect and the supported result packaging are qualified before that path is claimed usable. Retained data is not deleted to force a pass.

A real Pi Task exercises repository tools and review or apply, with a consistent Web or remote MCP terminal result. The built non-root image digest is a separate proof from synthetic search and host fixtures.

## Implementation

- `packages/worker-shim/`
- `packages/pi-runtime-host/`
- `containers/worker-runtimes/`

## Implementation Gaps

- Pi SDK 1.4.0 processing read-back - Exact original input correlation after lost ACK or volatile queue loss awaits qualification - #947

- Advertising script composition requires the released upstream fix, the carried patch, and exact-target, asset, credential, cancel, continuity, and image-result qualification - On main, the host supplies no composer and that qualification is open - #772
- A script or image result path is usable only after the pinned image-validation defect and supported result packaging are qualified - On main, that path is not claimed and retained data is not deleted to force a pass - #772
- A real Pi Task exercises repository tools and review or apply, with a consistent Web or remote MCP terminal result, and the built non-root image digest is proved - On main, synthetic search and host fixtures do not establish that proof - #120

## Decisions

- [Control Kernel And Service Storage](../decisions/20261120-control_kernel_and_service_storage.md)

- [Four native runtime adapters](../decisions/20260929-four_native_runtime_adapters.md)
- [Pi native MCP discovery](../decisions/20260930-pi_native_mcp_discovery.md)
- [Earlier-version data](../decisions/20260930-earlier_version_data_not_carried.md)
- [Sandbox full-capability rulings](../decisions/20261001-sandbox_full_capability_rulings.md)
- [Worker failure rulings](../decisions/20261015-worker_failure_final_and_chat_call_rulings.md)
- [Truthful native stop classification](../decisions/20261009-truthful_native_stop_classification.md)
- [Worker runtimes upgrade](../decisions/20261031-worker_runtimes_upgrade_to_latest.md)
