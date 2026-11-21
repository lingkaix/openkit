---
status: Accepted
kind: boundary
implementation: Partial
aspect: agent-session
---

# DeepSeek Worker Adapter

This specification owns the DeepSeek 0.2.1-rc.5 native ACP delta. Shared adapter rules live in [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md).

## Scope

Owns the DeepSeek ACP client mapping, its sidecar, and the v0.1.0 template exclusion.

Shared ACP code is extracted only when a second ACP runtime exists. Connection identity, native session identity, and the OpenKit AgentSession stay distinct.

Does not own:

- The shared adapter base. [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md) owns it.
- Private Harness operations. [Worker Control Protocol](20260703-worker_control_protocol.md) owns them.
- The image. [Worker Execution Environment Images](20260721-worker_execution_environment_images.md) owns it.
- Public live steer. [Task Mode](20260704-task_mode_worker_delegation.md) owns it.
- Continuity adoption. [AgentSession Continuity](20260704-agent_session_continuity.md) owns it.

Core: [AgentSession](../core/agent-session.md), [Sandbox](../core/sandbox.md).

## Runtime

The pin uses first-party native ACP over local stdio. The client SDK is 2.7.0 on stable ACP v1, against server SDK 1.4.0. The typed agent context is the actual connection. There is no narrower SDK wire, bridge, upward ACP, or generic daemon ([four native runtime adapters](../decisions/20260929-four_native_runtime_adapters.md)). Client major 2 does not select ACP protocol 2.

The runtime CLI is `dsh` 0.2.1-rc.5 plus the ACP client 2.7.0. The image installs that runtime on the shim resolution closure. Native profile composition helpers come from the same runtime closure. Smoke checks the pins, the path, and the non-root shared image.

## Launch And Session Mapping

Native profile, config, Skill, plugin, and local MCP precedence stay. The whole final protected ACP and LLM rows win, including when the protected native rows are disabled, duplicated, or missing. Collision warnings and unchanged authored files follow [Adapter Base Contract](20260629-worker_runtime_communication_model.md#adapter-base-contract).

Selected Skills are projected through the native managed provider beside the local, custom, and default providers, separate from authored local resources under [Static Supply Projection](20260629-worker_runtime_communication_model.md#static-supply-projection). Stale managed roots are removed. User profile roots and ordinary roots are not removed. The projection is ephemeral and is not a successor default.

A new open leaves the process absent and pending. The first bound Turn spawns the configured runtime, calls `session/new`, and then prompts. Ready requires native persistence and a successful sidecar publication. Resume calls the exact `session/resume`.

### Reasoning Effort Delivery

The adapter selects the model config option `reasoning_effort` and verifies the returned selection before the prompt. The native off codec follows [Adapter Base Contract](20260629-worker_runtime_communication_model.md#adapter-base-contract). An unchanged reasoning model is not reselected, because the native setter resets effort. A later selection never mutates the active prompt.

A route with `reasoning: true` is admitted. The catalog and model bounds are exact. Supported text and image projection follows [Adapter Base Contract](20260629-worker_runtime_communication_model.md#adapter-base-contract). Reasoning controls that are present, including an empty list, are sent. Absence sends no effort and a bounded diagnostic.

The sidecar retains cwd, MCP server ids, model, models, session id, and Skill target paths, plus each exact model, bounds, input, and optional reasoning. Known fields, positive bounds, and absolute Skill paths are validated. Additive sidecar members are ignored. Invalid ready metadata starts no process.

Native `session/new` and initialization resume mount the current MCP. There is no general replacement of an established live mount. The native protocol negotiates `2026-07-28` when the peer supports it. A fixed MCP, Skill, or cwd change refuses before a native request.

Cancel settles the addressed prompt only. A settled old Turn cannot cancel a successor. Output during the cancellation drain is allowed. Output after the close-drain boundary rejects the close.

Only a genuinely absent native home is initialized, from admitted image defaults, through a readable contained traversal, dereference, staging, and a final absence check. An existing whole home is reused, with no refresh and no legacy relocation.

## Event Mapping

### Native Output Mapping

A correlated prompt reply is classified with its ordered updates. `max_tokens` maps to length. `cancelled` needs request attribution. `max_turn_requests` and refusal map to error, never to budget exhaustion. Successful text is trimmed once. Empty success yields no candidate ([Truthful Native Stop Classification](../decisions/20261009-truthful_native_stop_classification.md)).

Compaction is recorded only from `compaction_update` and `compaction_summary_chunk`. Usage is not a compaction journal. Unobservable facts stay unavailable. Compaction notifications are not forwarded to the SDK.

Before the SDK, numeric prompt ids are correlated without coercion. NDJSON, the envelope, the known stop, and the content are validated. An unknown additive update is ignored and is not forwarded or logged. Overflow or unsupported content drops the text and proves stop.

Session updates accumulate under a 16 MiB ceiling before the SDK. Incremental UTF-8 and the final EOF flush preserve order. Diagnostics truncate at 16 KiB on a valid boundary.

An invalid or duplicate terminal poisons the binding irreversibly. Stdout, stderr, EOF, and error callbacks from an old generation cannot mutate the replacement collector, process, or identity.

After native creation, a sidecar publication failure or an unknown identity cannot claim ready or a clean close. A prompt that may have been submitted returns a fenced unsettled Turn until stop is proved. A genuinely pre-native validation failure preserves the original process.

## Deviations From The Base Contract

An idle resume mounts no MCP. The first admitted Turn mounts the current exact supply by an idle close and resume of the same id and host when that is required. That replacement may happen before the first prompt for the current Skills and catalog. An established host is not replaced mid-binding.

A successor may use a changed catalog only while the native recorded model remains admitted. Removing that model fails before the prompt, with a proved stop and unchanged bytes. Readmitting the model recovers the exact context.

Close requires a raw correlated native success before SDK normalization. Positive proof is a never-launched process, a native drain, or a same-generation native resume refusal. A timeout, a not-found text, or a local error is not that proof. Pipe EOF is a separate fact.

An actual observed first idle-resume native error, together with the matching SDK error, can prove a same-generation refusal. A missing acknowledgement, a timeout, or invalid proof never does. Close memoizes failure and always attempts a bounded stop.

A named group removes a shadowed protected declaration without removing siblings. An anonymous group protected row cannot be addressed. Model proof then fails, the host is stopped, and the bytes stay unchanged.

This pin adds no retained-history comparison and no read barrier. An acknowledged native close plus exact resume is the local predicate. Capture has an unsupported child source and excludes reasoning and the native title.

## Unsupported Operations

The controlled pipe is local. Initialize advertises protocol and client information only. Filesystem read, filesystem write, and terminal capabilities are not advertised. Only the permission and update handlers are supplied.

`session/load` is used only when that capability is advertised. The current profile advertises close, list, and resume. Pending RPC and inflight work are never restored, and replay is never inferred.

### Live Steer Refusal And Qualification Boundary

There is no qualified live steer. There is no adapter hook and no native call. Unsupported steer is definite nondelivery before a public Item. The adapter does not send another prompt, cancel and prompt, add a plugin, open a new Turn, or switch the wire.

The v0.1.0 template stays disabled and excluded until a released interface makes a correlated completed outcome distinguishable from an aborted or unknown outcome, and interruption and cleanup are qualified. An installed runtime grants no readiness ([runtime upgrade](../decisions/20261031-worker_runtimes_upgrade_to_latest.md)).

A generic direct Provider route rejects before process and prompt. There is no fallback external authority. Native launch uses the loopback patch and the fixed local ACP mode.

An allow-once permission uses the exact offered id. Otherwise the adapter reject-once cancels. It retains only the fixed bounded labels, not a secret and not an oversized option id.

A broader resume under the currently admitted selection, after the recorded model has been removed, stays unsupported until a native release can represent it. There is no error-text parsing workaround and no retained-data rewrite.

DeepSeek `dsh` 0.2.1-rc.5 on stable ACP v1 exposes no qualified live steer or per-input processing read-back. Unsupported steer refuses before admission or native contact. For a start whose contact was possible, missing exact processing evidence stays unknown. A folded native terminal result, reconnect or new prompt cannot resolve that input. Requalification requires an exact guarded Turn and read-back through ACK loss, cancellation, equal-text inputs and restart, with no spill to a later Turn. This rule keeps the native ACP wire version and relies on [Retained Delivery Proof](20260703-worker_control_protocol.md#retained-delivery-proof).

## Acceptance

The exclusion above is the acceptance boundary for this pin. A nonempty assistant chunk, and the absence of an OpenKit cancellation, do not prove completion while `end_turn` also covers aborted, error, and the vendor default.

A future steer mapping needs an accepted interface and pin, plus exact native same-Turn admission and terminal, interrupt, lost-response, restart, and no-spill qualification. A newer SDK alone is not that proof.

## Implementation

- `packages/worker-shim/`
- `containers/worker-runtimes/`
- `apps/nanocore/data-templates/config/agents/`

## Implementation Gaps

- Native `completed` is distinguishable from aborted and unknown - Released native terminal evidence remains unavailable because `dsh` 0.2.1-rc.5 folds those outcomes, error and the vendor default into `end_turn`; the production registry refuses fresh and resumed admission before native work - #773
- A future steer mapping proves exact native same-Turn admission and the terminal, interrupt, lost-response, restart, and no-spill cases - On main, this pin has no such native operation - #773
- An anonymous protected group row can be addressed without failing model proof - On main, that row cannot be addressed and the host stops with unchanged bytes - #773
- Resume under the currently admitted selection survives removal of the recorded model - On main, that resume fails closed until a native release can represent it - #773

## Decisions

- [Control Kernel And Service Storage](../decisions/20261120-control_kernel_and_service_storage.md)

- [Four native runtime adapters](../decisions/20260929-four_native_runtime_adapters.md)
- [Downward common runtime contract](../decisions/20260929-downward_common_runtime_contract.md)
- [One multi-runtime worker image](../decisions/20260930-one_multi_runtime_worker_image.md)
- [Earlier-version data](../decisions/20260930-earlier_version_data_not_carried.md)
- [Sandbox full-capability rulings](../decisions/20261001-sandbox_full_capability_rulings.md)
- [Truthful native stop classification](../decisions/20261009-truthful_native_stop_classification.md)
- [Worker runtimes upgrade](../decisions/20261031-worker_runtimes_upgrade_to_latest.md)
