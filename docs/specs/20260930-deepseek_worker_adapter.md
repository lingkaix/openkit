---
status: Accepted
implementation: Not Started
kind: boundary
date: "2026-09-30"
updated: "2026-09-30"
---
# DeepSeek Worker Adapter

## Summary

The DeepSeek Worker Adapter controls DeepSeek Harness by native ACP over Sandbox-local stdio, using `@agentclientprotocol/sdk` as an ordinary client library inside the adapter. ACP is the control interface because it is that runtime's first-party interface ([four native runtime adapters](../decisions/20260929-four_native_runtime_adapters.md), [ACP boundary](../decisions/20260929-downward_common_runtime_contract.md)).

The narrower SDK wire (`initialize`, `session/prompt`, and `shutdown` only) is not the control interface. It has no per-session cancel or close, and its prompt response is an enqueue receipt. The adapter does not also implement that wire. It does not add `codex-acp`, a Pi ACP bridge, or OpenCode ACP mode beside this path. It does not put ACP in the Sandbox Integration client. It does not create a generic ACP daemon. Shared ACP code is extracted only when a second ACP runtime exists. It does not equate the ACP connection id, the native session id, and the OpenKit AgentSession id.

The runtime process is supervised and disposable. Plugins do not run in the Integration and Harness process. The adapter does not use ACP for Core carriage, network transport, or worker-to-worker and upward communication. Those directions are MCP ([Communication](../core/communication.md)).

## Owns

- Native ACP session identity, prompt, cancellation, and close for one DeepSeek binding
- Translation of `session/update` into the shared Harness result
- Materialization of resolved MCP servers, including the built-in servers, on `session/new` and `session/resume`
- DeepSeek-specific version, event compatibility, and failure tests
- Failure mapping and conformance evidence for manifest-declared capabilities

## Does Not Own

- Canonical transcripts, AEP resolution, policy, product state, or Goal Mode
- Child-process supervision beyond the runtime process this adapter asks the shared Harness to supervise
- Client filesystem or terminal callbacks, which are not advertised
- Native permission round trips, which are not an OpenKit approval channel ([Pending Requests](20260930-pending_requests.md) owns approval delivery)
- Minting of the session loopback credentials, which [Worker Agent Capability](20260703-worker_agent_capability.md) owns
- A fourth image leaf, or an install of DeepSeek into `worker-common`

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-supply.md`
- `docs/core/sandbox.md`
- `docs/core/communication.md`

## Upstream Contract

No adapter, image target, manifest, or install recipe exists today. The deployment pin, the client pin, and the image install are established by this adapter's implementation slice from probes and recorded in the `worker-runtimes` version manifest. This specification does not guess those values and does not write an install command that has not been shown to work.

Examined evidence, not a deployment pin: source commit `639ed015397290b3745d163aafe02ffee4aa3f84`, package `@deepseek-ai/dsh-acp@0.2.0-rc.2`, depending on `@agentclientprotocol/sdk@1.4.0`. The ACP handshake value `0.0.1` is not a build id. The inspected package depends on `workspace:*` packages, so a standalone npm install is not established. The client pin is selected against that server peer. `@modelcontextprotocol/sdk` is a different package and is not this client.

The transport is the controlled local stdio pipe. It is not a public service. On the inspected server, authentication is an immediate success with no auth methods, so the pipe stays local. The local ACP connection must not follow the browser or NanoCore socket lifetime.

Native permission prompts are disabled ([Sandbox](../core/sandbox.md), [full permission inside the Sandbox](../decisions/20260930-full_permission_inside_the_sandbox.md)). If a native permission request arrives, the adapter selects an offered `reject_once` option, or cancels the prompt and records the request when none is offered. It never selects an allow option. Permission requests are not mapped to approvals.

## AEP Inputs Consumed

The shared Harness supplies the adapter with:

- adapter id `deepseek`
- turn input
- worker working directory
- the exact retained native id when resuming
- the provider, model, and admitted parameters for the native Turn
- the exact server ids from resolved AEP MCP supply, including automatically supplied built-in servers
- the two session-local loopback credentials, and no worker-control credential

The adapter does not invent provider, model, policy, or credential decisions. User configuration is preserved through the native profile. Generic per-session replacement of all tools, credentials, and Skills is not an ACP config option. Isolation is a configuration fact that must be proved, not inferred from session ids. Do not imply per-session isolation for global rows.

## Session Operations

One supervised runtime process per binding is the initial hosting, until shared-host isolation is proved ([image and adapter details in the accepted plan](../decisions/20260930-one_multi_runtime_worker_image.md)). The examined server can host more than one session. That capability is not the supported hosting until a sibling probe shows that credentials and Skill roots do not bleed. While hosting is one process per binding, close ends that process after the drain below. Once sharing is enabled, sibling sessions stay in the server map, and closing one binding must not close the shared connection, because connection teardown quiesces every session that connection owns.

`session.open` without a resume reference uses `session/new` and records the exact native id. `session.open` with a resume reference uses `session/resume` by that exact id and validates the retained session and workspace before any prompt. `session.open` carries `resume: { locator, digest } | null`. The raw id stays in retained Sandbox storage. Core stores the locator and the digest. The raw native id is never a product field, ordinary diagnostic, command result, or authorization input. Resume does not use search and does not use `session/list` as a guess.

The adapter uses `session/load` only when the negotiated capability set advertises it. `session/load` does not restore a pending RPC or in-flight work. The adapter does not claim history replay. Research on the examined source says loading and history replay are not advertised, while `session/resume` is.

`turn.start` sends the prompt on that session. Model selection is snapshotted for the admitted native Turn. A change applies to a later prompt, not to an in-flight request. `turn.interrupt` awaits the addressed prompt outcome and does not by itself close the session. `session.inspect` reads the exact surviving host and native conversation, launches no work, and fails closed on an unknown or mismatched identity.

`session.close` cancels, waits for admission and idle, drains ordered output and continuable descendants, flushes persistence, and disposes the addressed agent, without deleting retained context. That close drain is native output settlement for the addressed session. It is not `harness.drain`. Close that cannot drain is not success. Cancel and close report the actual outcome. `harness.drain` is the Harness admission fence. While admitted work and cleanup settle, this adapter refuses new `session.open` and `turn.start`. The Harness owns that fence. This adapter does not invent a native drain RPC.

The six operations are owned by [Worker Control Protocol](20260703-worker_control_protocol.md#harness-control-operations). This section maps each of them onto the open, inspection, prompt, interrupt, close, and admission-fence behavior above.

A successor resumes the exact id after a runtime-process restart. A runtime-host exit ends the bindings that process hosted. A transport loss and a NanoCore restart may each adopt the exact surviving binding, including its lineage, sequence, and lease, under the existing continuity and NanoHost proof contracts, with no duplicate effect. A binding that cannot be proved exactly is closed or fenced, and a successor resumes the native conversation. A NanoCore restart does not by itself end the binding. A crash during an effectful Turn ends the old AgentSession and does not claim effect rollback or automatic replay.

No environment variable, AEP extension, test option, or image diagnostic may replace the production ACP client. Tests inject a runner or a static test adapter without a production client override.

## Native Output Mapping

ACP carries `session/update` over stdio local to the Sandbox, to the extent the pinned profile advertises it. The addressed prompt's correlated native terminal outcome, in addition to those ordered updates, is what classifies the Turn as completed, failed, or interrupted. Partial text or an admission acknowledgement does not establish success. Failure and interruption normalize through the shared adapter-normalized result in [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md). Final text is the ordered text of the successful terminal outcome, trimmed once. Empty success is a correlated success with no assistant text and returns no assistant candidate. Native event names and SDK methods stay probe-selected. Unknown notifications do not satisfy a lifecycle predicate and do not enter NanoCore. NanoCore alone commits canonical Items.

If the client materializes a byte stream, native output is limited to 16 MiB and diagnostics keep at most a 16 KiB redacted prefix per stream. If the client materializes only session updates, the same 16 MiB bound applies to the accumulated update payload for one Turn, and the same 16 KiB prefix applies to diagnostic text. Credential values never appear in diagnostics. Live native token streaming into product Items is not supported.

Compaction evidence is only what ACP actually exposes. Usage changes are not a compaction journal. Unobservable facts stay unavailable.

## Control Mapping

- Prompt, cancel, and close are the supported product controls, addressed to one native session.
- `session/load`, when advertised, does not restore in-flight work.
- Filesystem and terminal callbacks are not advertised.
- Upward ACP is not a product path.
- `turn.interrupt` is the cancel above and does not close the session by itself.

## MCP

`session/new` and `session/resume` mount the exact resolved MCP supply. On the inspected source that mount consumes tools, not MCP resources or prompts. There is no general live-replacement operation on the examined source. That fact is evidence the probe must check. It is not, by itself, the declaration of re-list behavior.

The adapter declares whether tools are re-listed at Turn start. The implementation slice establishes that declaration by probe, and this specification does not invent it. When the runtime does not re-list, a changed supply is a setup change replaced by a successor AgentSession that resumes the exact id. Narrowing and revocation still apply at the next call as `capability_denied`.

In-Sandbox MCP is unrestricted. External systems stay on the Gateway ([Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md)). The adapter must not discover, install, directly connect, authorize, or broaden supply beyond the exact selection. ACP is not added to that specification as a permission channel.

## Provider And Credentials

The two supplied loopback bearers are what the native process uses for inference and MCP. Mint, attribution, the Turn-barrier drain, and destruction belong to [Worker Agent Capability](20260703-worker_agent_capability.md). The native process never holds upstream Turn tokens, and the worker-control token never enters the runtime. An unsupported route fails closed. Idle refusal, sibling refusal, and Turn-barrier behavior are consumed from that contract.

The native field that carries each loopback credential is established by probe and is not named here. Credential values never appear in diagnostics or evidence.

Declared runtime-env credentials are session-static. A changed declaration or value yields a successor AgentSession at the next Turn. A revocation interrupts and closes the binding at once. Direct routes that the selected profile cannot represent fail closed before the prompt.

## Manifest And Image Contract

The DeepSeek AgentManifest selects adapter id `deepseek`, the deployment image `worker-runtimes`, and its own `targetRuntime`. [Worker Execution Environment Images](20260721-worker_execution_environment_images.md) owns that image. Image membership is the declared set of that one deployment image, not a fourth leaf and not an install into `worker-common`. Image contents confer no adapter authority. This version starts from a new data root and does not read earlier-version data ([earlier-version data is not carried](../decisions/20260930-earlier_version_data_not_carried.md)).

Smoke of the deployment image proves the selected DeepSeek binary when the install probe has established one. Until that probe, image install stays blocked and this interface stays normative. Deleting the adapter removes DeepSeek ACP knowledge from the shared contract and does not remove the shared image.

## Failure Semantics

- Missing, inactive-but-mismatched, or wrong-workspace resume fails explicitly, with no transcript replay and no fresh-session fallback.
- Close that cannot drain is not success.
- Cancel and close report the actual outcome.
- A crash during an effectful Turn ends the old AgentSession and does not claim effect rollback or automatic replay.
- Unknown notifications cannot complete a Turn.
- Over-limit output fails closed.
- A native permission request is `reject_once` or cancel-and-record, never allow.
- Close preserves retained native data and proves writer absence for the binding.

## Capability Declaration

The authored manifest is the sole capability declaration. Adapter conformance does not return a second capability declaration. The manifest advertises:

- ACP `session/new`, exact `session/resume`, prompt, cancel, and close: supported
- MCP tool mounting for selected supply: supported
- Native permission round trips: not supported
- Filesystem or terminal callbacks: not supported
- Live product-item streaming: not supported
- Upward ACP: not supported

## Tests

Required tests cover:

- `session/resume` by exact id after a process restart, then `session/close`, with no further `session/update`
- Cancel addressed to one session
- If a shared process is under test, the sibling remains and credentials and Skill roots do not bleed
- Permission requests are not mapped to approvals
- Compaction claims use only observed ACP facts
- The production client cannot be replaced by an environment override
- Credential values absent from diagnostics, and the worker-control token absent from the runtime
- A supply change between two Turns either shows the new supply on the second Turn or follows the probed setup-change successor, checked on the model-visible schema
- The 16 MiB and 16 KiB bounds, or the session-update equivalent stated above
- Successful completion from the addressed prompt's correlated native terminal outcome, partial output followed by failure, cancellation, and missing or conflicting terminal evidence
- Final text as the ordered text of the successful terminal outcome trimmed once, and empty success returning no assistant candidate
- Inspection of the exact surviving host and native conversation, rejection of an unknown or mismatched identity with no work launched, and `harness.drain` refusing new `session.open` and `turn.start` while admitted work and cleanup settle

The shared qualification cases in [Codex Worker Adapter](20260716-codex_worker_adapter.md#tests) apply on native ACP. The SDK wire and a third-party ACP bridge are not alternate passing interfaces. One runtime's pass does not qualify another.

## Implementation Evidence And Limit

No DeepSeek adapter, image target, manifest, or install recipe exists in the tree. The accepted design is this specification. Nothing here is implemented.

## Acceptance

This adapter is clean only when deleting it removes DeepSeek ACP knowledge from the shared worker contract and from NanoCore. The deployment image is shared and is not deleted with the adapter.

## Related Documents

- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
- `docs/specs/20260721-worker_execution_environment_images.md`
- `docs/specs/20260716-codex_worker_adapter.md`
- `docs/specs/20260930-pending_requests.md`
