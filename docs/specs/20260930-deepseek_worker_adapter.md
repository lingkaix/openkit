---
status: Accepted
implementation: Partial
kind: boundary
date: "2026-09-30"
updated: "2026-10-01"
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

The resident adapter is implemented; image and manifest integration remain outside this slice, as Implementation Evidence And Limit states. The deployment pin, the client pin, and the image install are established by this adapter's implementation slice from probes and recorded in the `worker-runtimes` version manifest. This specification does not guess those values and does not write an install command that has not been shown to work.

Examined evidence, not a deployment pin: source commit `639ed015397290b3745d163aafe02ffee4aa3f84`, package `@deepseek-ai/dsh-acp@0.2.0-rc.2`, depending on `@agentclientprotocol/sdk@1.4.0`. The ACP handshake value `0.0.1` is not a build id. The inspected package depends on `workspace:*` packages, so a standalone npm install is not established. The client pin is selected against that server peer. `@modelcontextprotocol/sdk` is a different package and is not this client.

The transport is the controlled local stdio pipe. It is not a public service. On the inspected server, authentication is an immediate success with no auth methods, so the pipe stays local. The local ACP connection must not follow the browser or NanoCore socket lifetime.

The runtime launches with full access and full permission inside the Sandbox ([Sandbox](../core/sandbox.md), [Sandbox full-capability rulings](../decisions/20261001-sandbox_full_capability_rulings.md)). A residual native permission request defaults to the offered allow-once decision. The existing refusal-capable decision path remains reserved for future user-configurable policy; no policy setting is introduced. Explicit user-authored deny rules remain effective. Permission requests are not mapped to OpenKit approvals, and external effects remain governed by the Gateway.

## AEP Inputs Consumed

The shared Harness supplies the adapter with:

- adapter id `deepseek`
- turn input
- worker working directory
- the exact retained native id when resuming
- the provider, model, and admitted parameters for the native Turn
- the exact server ids from resolved AEP MCP supply, including automatically supplied built-in servers
- the two session-local loopback credentials, and no worker-control credential

The adapter does not invent platform Provider, model, policy, or credential decisions. It honors native configuration and profile precedence under Native Local Configuration and composes only the protected bindings it owns. Generic per-session replacement of all tools, credentials, and Skills is not an ACP config option. Isolation is a configuration fact that must be proved, not inferred from session ids. Do not imply per-session isolation for global rows.

## Native Local Configuration

DeepSeek's native configuration, profiles, instructions, Skill roots, plugins and local MCP configuration keep their native precedence in the admitted home and workspace. Image defaults reach the home by native layering where the pin supports it, otherwise by initializing a fresh home, under [Persistent Worker Volumes](20260910-persistent_worker_volumes.md#native-defaults-and-private-home-placement). The adapter projects the AEP-selected Skills and managed MCP separately, removes stale managed roots, and does not disable native default Skill roots or replace a whole user profile row to do so. It overlays only the bindings it owns: the model and Gateway route, the exact OpenKit-managed MCP projection, the capability credentials, the exact session and ACP control. OpenKit applies its protected bindings as the last layer, replacing the whole protected entry when necessary; disabled, duplicated, or missing native protected rows do not displace them. A conflict emits a warning through the existing worker diagnostic envelope without editing the user's files ([Sandbox full-capability rulings](../decisions/20261001-sandbox_full_capability_rulings.md)). Closing or failing a binding preserves the whole native home, and the adapter's protected projection is not written into the retained profile as a default for a successor.

## Session Operations

One supervised runtime process per binding is the initial hosting, until shared-host isolation is proved ([image and adapter details in the accepted plan](../decisions/20260930-one_multi_runtime_worker_image.md)). The examined server can host more than one session. That capability is not the supported hosting until a sibling probe shows that credentials and Skill roots do not bleed. While hosting is one process per binding, close ends that process after the drain below. Once sharing is enabled, sibling sessions stay in the server map, and closing one binding must not close the shared connection, because connection teardown quiesces every session that connection owns.

`session.open` without a resume reference creates a private pending binding but does not launch the native process or call `session/new`. The first `turn.start`, after Integration has bound that Turn's routes, supplies the resolved working directory, model configuration, and selected supply; the adapter then creates the native conversation with `session/new` before sending the prompt. The handle becomes ready only after native persistence and every adapter-required resume record are durable. Failure before that proof never publishes a ready reference. `session.open` with a resume reference uses `session/resume` by that exact id and validates the retained session and workspace before any prompt. `session.open` carries `resume: { locator, digest } | null`. The raw id stays in retained Sandbox storage. Core stores the locator and the digest. The raw native id is never a product field, ordinary diagnostic, command result, or authorization input. Resume does not use search and does not use `session/list` as a guess.

A resumed open proves the exact retained native conversation and workspace without contacting the capability loopback. Before the first prompt, after Integration binds that Turn's routes, the adapter mounts the exact current AEP MCP supply; when necessary it closes the idle initialization session and resumes the same native id on the same host before admitting any prompt. This initialization remount does not authorize later setup changes within an established binding. Before the first Turn of a binding sends its prompt, the adapter may replace the process that proved a resumed conversation with one configured for that Turn's Skill paths and exact admitted model catalog, and it proves the same conversation again before the prompt; an established binding never replaces its process.

The adapter uses `session/load` only when the negotiated capability set advertises it. `session/load` does not restore a pending RPC or in-flight work. The adapter does not claim history replay. Research on the examined source says loading and history replay are not advertised, while `session/resume` is.

`turn.start` sends the prompt on that session. Model selection is snapshotted for the admitted native Turn. A change applies to a later prompt, not to an in-flight request. `turn.interrupt` awaits the addressed prompt outcome and does not by itself close the session. `session.inspect` reads the exact surviving host and native conversation, launches no work, and fails closed on an unknown or mismatched identity.

`session.close` cancels, waits for admission and idle, drains ordered output and continuable descendants, flushes persistence, and disposes the addressed agent, without deleting retained context. That close drain is native output settlement for the addressed session. It is not `harness.drain`. Close that cannot drain is not success. Cancel and close report the actual outcome. `harness.drain` is the Harness admission fence. While admitted work and cleanup settle, this adapter refuses new `session.open` and `turn.start`. The Harness owns that fence. This adapter does not invent a native drain RPC.

The six operations are owned by [Worker Control Protocol](20260703-worker_control_protocol.md#harness-control-operations). This section maps each of them onto the open, inspection, prompt, interrupt, close, and admission-fence behavior above.

A successor resumes the exact id after a runtime-process restart. A runtime-host exit ends the bindings that process hosted. A transport loss and a NanoCore restart may each adopt the exact surviving binding, including its lineage, sequence, and lease, under the existing continuity and NanoHost proof contracts, with no duplicate effect. A binding that cannot be proved exactly is closed or fenced, and a successor resumes the native conversation. A NanoCore restart does not by itself end the binding. A crash during an effectful Turn ends the old AgentSession and does not claim effect rollback or automatic replay.

No environment variable, AEP extension, test option, or image diagnostic may replace the production ACP client. Tests inject a runner or a static test adapter without a production client override.

## Reasoning Effort Delivery

For every Turn with recorded effort in its immutable AEP, the adapter uses ACP `session/set_config_option` with `configId: "reasoning_effort"` after selecting the admitted model and before `session/prompt` admits the prompt on the exact retained session. The [canonical OpenKit enum](../core/protocol.md#canonical-enums) maps `none` to native `off`; other supported names are unchanged. The native `llm-pi-ai` model metadata declares an explicit supported-level map preserving exact Gateway wire values, including `off` to `none`, and exposes those levels through the model's ACP option. The adapter verifies the returned current selection. Explicit `none` uses `off` with that map, never omission, null, or the native provider-default sentinel.

Shared delivery, omission and retention, Turn authority, effective-level diagnostics, failure and lifecycle semantics, and acceptance are owned by [AEP delivery and retention](20260616-agent_environment_package.md#reasoning-effort-projection-and-delivery).

DeepSeek-specific acceptance proves that ACP `session/set_config_option` with `configId: "reasoning_effort"` applies the selected level after admitted model selection and before `session/prompt`, that the returned current selection is verified, that native `off` reaches Gateway as canonical `none`, and that other supported native levels preserve their exact Gateway wire values through the declared map.

## Native Output Mapping

ACP carries `session/update` over stdio local to the Sandbox, to the extent the pinned profile advertises it. The addressed prompt's correlated native terminal outcome, in addition to those ordered updates, is what classifies the Turn as completed, failed, or interrupted. Partial text or an admission acknowledgement does not establish success. Failure and interruption normalize through the shared adapter-normalized result in [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md). Final text is the ordered text of the successful terminal outcome, trimmed once. Empty success is a correlated success with no assistant text and returns no assistant candidate. Native event names and SDK methods stay probe-selected. Unknown notifications do not satisfy a lifecycle predicate and do not enter NanoCore. NanoCore alone commits canonical Items.

If the client materializes a byte stream, native output is limited to 16 MiB and diagnostics keep at most a 16 KiB redacted prefix per stream. If the client materializes only session updates, the same 16 MiB bound applies to the accumulated update payload for one Turn, and the same 16 KiB prefix applies to diagnostic text. Credential values never appear in diagnostics. Live native token streaming into product Items is not supported.

Compaction evidence is only what ACP actually exposes. Usage changes are not a compaction journal. Unobservable facts stay unavailable.

## Control Mapping

- Prompt, cancel, and close are the supported product controls, addressed to one native session.
- `session/load`, when advertised, does not restore in-flight work.
- Filesystem and terminal callbacks are not advertised. Native in-Sandbox shell and file tools remain available through the runtime’s own backends.
- Upward ACP is not a product path.
- `turn.interrupt` is the cancel above and does not close the session by itself.

## MCP

Native creation and the first-Turn initialization resume mount the exact current resolved MCP supply. An idle identity-proof resume mounts no MCP servers, as Session Operations specifies. On the inspected source that mount consumes tools, not MCP resources or prompts. There is no general live-replacement operation on the examined source. That fact is evidence the probe must check. It is not, by itself, the declaration of re-list behavior.

This adapter does not re-list tools at Turn start. A supply change requires a successor AgentSession that resumes the exact conversation after the predecessor Turn settles. A later change to the MCP server id set, the Skill path set, or the working directory is refused before any native request inside an established binding. Narrowing and revocation still apply at the next call as `capability_denied`.

In-Sandbox MCP follows native local configuration. OpenKit-managed MCP remains exactly selected and Gateway-projected; the adapter cannot broaden or directly replace that selection. Other external traffic follows the MCP and Sandbox/network owners, including admission-classified public endpoints and separately authorized REST grants. ACP does not become an authorization channel.

## Provider And Credentials

The two supplied loopback bearers are what the native process uses for inference and MCP. Mint, attribution, the Turn-barrier drain, and destruction belong to [Worker Agent Capability](20260703-worker_agent_capability.md). The native process never holds upstream Turn tokens, and the worker-control token never enters the runtime. An unsupported route fails closed. Idle refusal, sibling refusal, and Turn-barrier behavior are consumed from that contract.

The adapter must accept an admitted Gateway route whose model declares `reasoning: true`; that flag alone cannot make the route unsupported or refuse the prompt. Acceptance requires such a reasoning route to reach native inference through the same protected Gateway binding without direct Provider authority. This replaces the earlier refusal under [the tier-routing decision record](../decisions/20261001-gateway_tier_routing_rulings.md) and is distinct from the Reasoning Effort Delivery contract above.

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
- Native profile and local Skill roots effective alongside the current managed roots, a fresh home receiving image defaults, a populated home preserved, and native protected-row conflicts overridden with a diagnostic warning and unchanged authored configuration
- Model-directed native shell and workspace file-write effects observed directly, a native local MCP tool result reaching the next model request beside managed MCP, and authored instructions present in the model request

The shared qualification cases in [Codex Worker Adapter](20260716-codex_worker_adapter.md#tests) apply on native ACP. The SDK wire and a third-party ACP bridge are not alternate passing interfaces. One runtime's pass does not qualify another.

## Implementation Evidence And Limit

The resident DeepSeek adapter is implemented in `packages/worker-shim/src/adapters/deepseek.ts` and registered as `deepseek`. It spawns pinned `@deepseek-ai/dsh@0.2.0-rc.2` by resolving that package's `lib/bin.js` and running it with `process.execPath` and `--profile acp --patch`, and it speaks ACP through a direct import of `@agentclientprotocol/sdk@1.4.0`. The npm registry on 2026-09-30 reports `latest` and `next` of `@deepseek-ai/dsh` as `0.2.0-rc.2` and publishes no stable release. `@deepseek-ai/dsh-acp@0.2.0-rc.2` is the `next` server plugin and depends on SDK `1.4.0`; its `latest` tag `0.0.1-rc.1` depends on SDK `0.25.1` and is not the pin. `@deepseek-ai/dsh` is a devDependency of `@openkit/worker-shim` so the package does not enter `worker-common`. The `worker-runtimes` image must install `@deepseek-ai/dsh@0.2.0-rc.2` where `require.resolve('@deepseek-ai/dsh/package.json')` succeeds from the worker-shim module graph. Registry unpacked sizes are 73328 bytes for the CLI, 102032 bytes for `dsh-acp@0.2.0-rc.2`, and 5586531 bytes for SDK `1.4.0`. `du -sk` of those installed store directories was 128, 132, and 5872. The resolved executable is `node_modules/.pnpm/@deepseek-ai+dsh@0.2.0-rc.2_1578d8da91e96883e952a2d2d1413a9c/node_modules/@deepseek-ai/dsh/lib/bin.js`.

Vitest against that distribution and a synthetic loopback, with no network, proved the following on rc.2. Two Turns keep one native conversation and the second model request contains the prior user text. Successful text is trimmed once, and empty success returns no assistant text. Close leaves the native session store, and a successor `session/resume` of the same id continues that conversation. SIGKILL during a prompt fails that Turn with no assistant text, and a new process resumes the same id with a different pid. `session/cancel` interrupts the addressed prompt, the handle stays ready, and a later prompt completes. A resumed open while every capability request is refused stays ready, does not contact the capability loopback, and keeps the same native id. The first Turn after that open mounts that Turn's MCP supply once, closing the idle session and resuming the same id on the same host when the supply is non-empty; the model-visible tool name is the mounted server and the prior user text remains. A distinct successor also reproves the same native id and workspace on a process with changed Skill paths before its first prompt; the second model request contains the prior context and the new runtime-visible Skill. A later MCP or Skill change within an established binding is rejected before any native request, and a following Turn with the original setup still completes. The adapter does not re-list. A model stream that drops after one chunk fails the Turn with no assistant text, and the diagnostics do not contain the inference credential. Corrupt, missing, and wrong-workspace resume report an unknown handle and launch no fresh conversation. A direct-provider route throws before a process exists.

`openSession` without a resume reference leaves the handle pending and the process absent. The first `startTurn` writes the loopback patch, spawns the process, and calls `session/new`. This follows the deferred creation rule in Session Operations. The Harness open input has no working directory and no model. Resume at open still calls `session/resume` for the exact id and does not fall back to `session/new`. The installed `dsh-acp@0.2.0-rc.2` initialize result advertises session capabilities `close`, `list`, and `resume` only, so `session/load` is not called. The adapter's initialize request sends `protocolVersion` and `clientInfo` only. The SDK schema default for omitted client capabilities is filesystem read and write false and terminal false. The client implementation supplies `requestPermission` and `sessionUpdate` only.

One process per binding is the hosting, and shared-process sibling isolation is unimplemented. MCP server ids, Skill paths, and the working directory are fixed for an established binding. A successor can reprove the same native id and workspace on a replacement process configured for its first Turn's Skill paths and exact admitted model catalog before sending a prompt when that catalog retains the model recorded by the native conversation. At pinned rc.2 a catalog excluding that recorded model fails explicitly before any prompt, with proved host stop and unchanged retained conversation and sidecar bytes; a later successor under a catalog including it resumes the exact conversation with prior context. In the pinned dsh-acp lib/index.js, selectionFor restores the latest logged provider/model, AcpModelControl.state rejects an initially unavailable selection, and resumeSession requires option discovery before replying. The sidecar startup selection can differ from the latest logged model, so native resume decides availability without parsing error messages. Removing a model from a DeepSeek agent's admitted set stops existing DeepSeek Threads that last used it until the model is admitted again. Remove this known limit when a pinned dsh release can resume under a currently admitted selection. A later difference is rejected before any native request and the original process stays usable. This is the successor-AgentSession declaration: the adapter does not re-list, and it does not restart the host to apply the change. A probe of pinned `dsh@0.2.0-rc.2` and SDK `1.4.0` on 2026-09-30 showed that `session/set_model` is method-not-found, that `session/set_config_option` with configId `model` selects another configured model on the same session, and that rewriting the patch file on a live process does not extend the catalog. The catalog also advertises built-in `deepseek-official` models, which this adapter does not select. The required allowedLlmRoutes input renders every admitted logical model with its own bounds and modalities. An established catalog is compared order-independently and a preferred model can change inside it; every prompt is preceded by a verified setSessionConfigOption model selection. Unsupported members, absent admitted sets, mismatched preferences, and established catalog changes are refused before native requests. The current generated model has `reasoningEfforts: false` and does not advertise the `reasoning_effort` option; this is a current-state gap from the accepted delivery target above. The current implementation admits a route with `modelParameters.reasoning === true` as an ordinary native model without an effort control; native effort delivery remains awaiting implementation. Native permission requests default to the offered allow-once option and retain reject-once or cancellation when allow-once is absent. The SDK response uses the offered id while diagnostics retain only a fixed decision label, never a secret-valued or oversized option id. Live prompts under `DSH_PERMISSION_MODE=danger-full-access` did not emit that request. Compaction is `observed` when `compaction_update` or `compaction_summary_chunk` is admitted, and those notifications are not forwarded to the SDK. The 16 MiB session-update ceiling is applied before the SDK sees the line. One over-limit update and two updates whose sizes sum past the ceiling both fail the Turn with no assistant text after the dedicated process is confirmed stopped. The 16 KiB diagnostic prefix is truncated on a UTF-8 boundary, so a trailing euro does not expand to a replacement character past the limit. Stateful stdout decoding preserves multibyte text at each tested byte split; adjacent notification lines remain ordered, and the decoder flushes an incomplete UTF-8 tail at EOF before frame admission. Pre-SDK admission correlates numeric prompt request ids without string coercion and rejects the tested malformed NDJSON, invalid envelope types and response shapes, unknown required stop reasons, and contradictory terminal responses before publication. The SDK still owns method payload schemas and routing; its pinned public API exposes no general envelope validator. A duplicate terminal after publication fences that binding and cannot attach to a successor Turn. Invalid consumed `agent_message_chunk` content stops the dedicated process with bounded exit confirmation and fails the Turn as `unsupported_content` and is absent from `console.error` and diagnostics. An unknown additive `session/update` is ignored, its contents are not forwarded, and the Turn can still complete. `session/update` lines are classified before SDK validation. `harness.drain` is owned by the Harness and is covered there by a fixture adapter, not by this process. Same-session selection through setSessionConfigOption is covered by resident-adapter regressions with two differently described admitted models, the same native id and process, retained context, and no MCP remount. The catalog-only and changed-Skill/MCP successor regressions verify explicit dependency_failed refusal, no prompt or new conversation, proved process stop, unchanged retained bytes, and recovery of the same context once the recorded model is admitted again.

A rejected `openSession` leaves no DeepSeek process. Resume failures stop the process and confirm `exit` before the open returns an unknown handle; when that exit is not observed, the open still returns the session and `close` fails so the Harness fences. A rejected `startTurn` is reached only after the process has been confirmed exited, so the prompt is not left running. Successful close uses a closed set of recorded positive proofs: no native host launch, completed native drain/close of the published session, or an observed native JSON-RPC error response to same-generation idle successor resume without native creation. Host launch clears any prior proof. The existing outbound-prefix reader correlates the idle resume request id with its first admitted native reply; a native error response records the same-generation refusal proof at that RPC boundary. The pinned SDK RequestError outcome must agree with that observed proof; a client-created RequestError alone is insufficient. A confirmed admission stop ends later Turn admission before any setup, spawn, native RPC, or inference; the ongoing first admission may still replace its idle proof host. A public-path regression retains successful close after genuine refusal and exact recovery through a separate successor. The request correlation ends on the first reply or bounded RPC completion, so a late response cannot invent proof after timeout. The adapter validates envelopes before SDK admission and never uses the public harnessReasonCode or message text as internal cleanup proof. Invalid native evidence clears the proof through its existing owner. Invalid session/new identity or model evidence after actual creation becomes unknown, starts no prompt, proves stop, and rejects close. A null unpublished id after launch, local timeout, missing acknowledgement, failed native close/flush, and invalid results cannot fall through to success. Pre-launch invalid metadata keeps its no-native-work successful close. Adapter and actual Harness regressions withhold a real successful replacement resume acknowledgement, observe bounded local timeout and stopped host without new inference, and require rejected close, cleanup_required, failed/unknown cleanup inspection, and continued successor fencing. The prior admission-time channel-loss, initialization close/flush, and invalid model-proof regressions retain their rejected-close boundary. A real-Harness regression on N4c observes ordinary dependency_failed refusal, clean disposable inputs, zero active-Turn occupancy, an absent host and unknown current handle, successful close, and a later same-Harness successor recovering the exact retained conversation with prior context. This differs from a native close/flush failure or unsolicited channel loss, which retains its existing failed-close path. Validation that happens before any native call for that Turn, such as a direct-provider route or a working-directory mismatch, rejects with the existing process untouched because no Turn was submitted. When the stop cannot be confirmed, `startTurn` returns a Turn whose `settled` rejects and whose `interrupt` stays pending, which is the Harness fence for an unproved native stop. An unrepresentable MCP id is rejected before spawn, so no pid file is written. The live stop proof is a sidecar path that cannot be written after `session/new`: `startTurn` rejects, the handle is not ready, and the recorded pid is gone. Ready is published only after that sidecar write returns. Invalid required sidecar fields, including a non-positive bound, an unknown modality, a relative Skill path, an unrepresentable MCP id, a missing model catalog, or a missing model, produce an unknown handle and start no process. Unknown additive sidecar fields are ignored. Close is one shared promise, including after rejection. A native close or persistence-flush failure rejects close after bounded process cleanup, and a stopped host whose drain times out also rejects close. Admission or drain timeout does not fulfill the active Turn before exit proof: confirmed process stop permits a failed result, while unproved stop rejects settlement. Lost real stdin, stdout, or intermediate SDK transport immediately invalidates inspection and admission proof, retires SDK pending requests, and takes the same bounded stop path, including idle channel loss. Intentional close and pre-first-prompt proof-host replacement retire the transport without classifying their shutdown as unsolicited channel failure. Captured-generation guards precede stdout framing, EOF flushing, stderr capture, and outbound request-prefix capture; late callbacks from a replaced host cannot affect the current collector, handle, or process. Regressions deliver old stdout data and one deferred real old EOF while the current stream holds a partial frame, preserving exact fresh text, the current handle/process, no erroneous exited signal, and successful close; old error/close controls and current-host late-drain/EOF checks remain enabled. Subprocess tests treat uncaught stream errors and unhandled rejections as failing checks. Invalid content and overflow retain their failure cause and discard assistant text while bounded process cleanup establishes stop; no later caller interrupt is needed. A session update injected through actual stdout after the drain boundary fails close, and a second close returns that same rejection. A failed native close or flush also rejects close after process cleanup. Output while cancellation is draining does not. A settled Turn's interrupt does not cancel its successor. Cancellation inside a hanging MCP tool call settles `interrupted` / `cancelled`. A prompt RPC error with or without cancel is not settlement proof: the process is stopped and the Turn settles `failed` / `host_ended` when exit is proved; if stop remains unproved, settlement rejects for Harness fencing. Interrupt bounds both native cancel response and prompt settlement, then stops the process when the latter remains unproved. `session/new` returns an id that a second process can resume before any prompt, with zero inference requests, after SIGKILL. Redirecting `HOME` keeps an operator-home canary out of the state and control roots. The runtime can still read workspace-owned configuration such as the invoking workspace's `.env`; that is not operator ambient configuration, and this adapter does not claim to suppress it. An unproved stop rejects the private settlement promise so the Harness attempts interruption and fences when stop remains unproved. The adapter does not edit the Harness. An unproved stop is covered by the pending-interrupt helper because SIGTERM and SIGKILL reap this process in the test sandbox.

pnpm ignored build scripts for `@deepseek-ai/dsh-subprocess-local@0.2.0-rc.2`, `koffi@3.1.1`, and `node-pty@1.2.0-beta.15`. The ACP profile tests above completed without those native modules. Real-pin synthetic-loopback regressions exercise native bash and file writes through their own backends without client filesystem or terminal capabilities. Image membership, the DeepSeek AgentManifest, and `containers/` are outside this slice. The deployment image is `worker-runtimes` and the declared set is `codex`, `pi`, `opencode`, `deepseek`.

Native Local Configuration is implemented and qualified against the real `@deepseek-ai/dsh@0.2.0-rc.2` pin with synthetic loopback inference and MCP. The pin reads no independent image-user default layer beside explicit `DSH_HOME`, so the adapter initializes the genuinely absent `stateRoot/dsh-home` child from the shim process's own `HOME/.dsh` only outside the retained root. Existing homes are reused without refresh. Traversal validates readability and containment, contained links are copied by dereference, staging is `dsh-home.initializing`, leftover staging refuses open, and a final absence check precedes rename under the Thread lease. No earlier-version relocation or legacy reader is present. Read-only native patch composition identifies conflicts for diagnostics; last-layer complete protected rows shadow native ACP and LLM declarations without rewriting the profile. Selected Skills use a native inserted `openkit-managed` provider beside local/custom/default providers, while managed MCP stays on the exact ACP mount. The native entry id replaces an earlier managed provider row without changing local roots. Tests qualify image-default application on a Turn, byte-preserving reuse despite source replacement, absent and invalid sources, staging and publication refusal, local profile and Skill coexistence with empty and nonempty managed sets, stale managed-root removal on exact successor resume, and protected-row override warnings. The pin indexes nested row ids globally, so the disposable overlay also removes protected declarations from named native group projections while retaining ordinary siblings. Anonymous native groups have no stable target for the pin’s final patches: a disabled protected ACP row inside such a group still fails the existing model proof before inference, with a stopped host and unchanged authored bytes. This pin limitation remains unresolved; supporting it requires a native way to replace or address that anonymous group without changing authored files. Successful-Turn warnings currently remain on adapter result diagnostics because the shared Turn consumer publishes that existing diagnostic map only on failures; no new protocol event or member is introduced. Native local stdio MCP calls return their results to the next model request beside the managed Gateway tool schema, and authored home/workspace instruction sentinels reach the model. Native conversation history retains earlier Skill catalogs; the pin emits a complete replacement catalog for current availability. These qualifications cover native configuration and resource loading, not arbitrary plugin effects. Independent review remains outside this builder slice.

The Reasoning Effort Delivery contract above is an accepted target awaiting implementation. The current adapter does not deliver the recorded per-Turn override through the ACP reasoning-effort option or supply its explicit native level map.

## Acceptance

This adapter is clean only when deleting it removes DeepSeek ACP knowledge from the shared worker contract and from NanoCore. The deployment image is shared and is not deleted with the adapter.

## Related Documents

- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
- `docs/specs/20260721-worker_execution_environment_images.md`
- `docs/specs/20260716-codex_worker_adapter.md`
- `docs/specs/20260930-pending_requests.md`
