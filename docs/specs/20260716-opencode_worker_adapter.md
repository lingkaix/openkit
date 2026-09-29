---
status: Accepted
implementation: Partial
kind: boundary
updated: 2026-09-30
---
# OpenCode Worker Adapter

## Generic Volume Retention Amendment

[Persistent Worker Volumes](20260910-persistent_worker_volumes.md) owns complete opaque data/home volumes and supersedes this adapter's deletion of native data at ordinary Turn or AgentSession close. The adapter locates its data directory in its admitted stable Thread-private home and leaves all contents intact, without a list of known filenames. Generated launch and control material remains in separate ephemeral roots. Opening or closing a native binding must not recursively erase the retained data directory. Closing still invalidates the exact binding and proves writer absence. Retained native histories, memory, configuration, and unknown files do not select a conversation or grant tools or credentials.

OpenCode V2 server operations, event translation, and feature restrictions remain owned here. Whole-volume retention alone does not discover a session or grant tools or ambient configuration as launch authority. Exact resume uses the retained reference under [AgentSession](../core/agent-session.md). A resume that is not the exact session fails explicitly and never falls back to a fresh conversation, an empty conversation, or a transcript replay. This version starts from a new data root and does not read earlier-version native state ([earlier-version data is not carried](../decisions/20260930-earlier_version_data_not_carried.md)).

## Summary

The OpenCode Worker Adapter uses one supervised OpenCode V2 native server per binding and `@opencode/client` as the network client. It translates that server's correlated terminal result into the shared OpenKit Harness result.

The server is not an OpenKit control plane, and its HTTP routes are not NanoCore routes. It must not imitate an OpenKit gateway. Plugins run in the server process, not in the Integration and Harness process. The adapter does not embed `@opencode/sdk` in the caller and does not add an OpenKit IPC wrapper to do so. It does not use OpenCode ACP mode. It does not keep `opencode run` ([four native runtime adapters](../decisions/20260929-four_native_runtime_adapters.md)). Each runtime is qualified on its own.

## Owns

- OpenCode V2 server configuration, native session identity, and event translation for one resident binding
- Final assistant text extraction from the correlated server result
- OpenCode-specific version, event compatibility, and failure tests
- OpenCode-specific failure mapping and conformance evidence for manifest-declared capabilities

## Does Not Own

- OpenCode server lifecycle inside NanoCore
- Child-process supervision beyond the server process this adapter asks the shared Harness to supervise
- AEP resolution, provider selection, credential grants, network policy, or backend lifecycle
- Canonical transcripts, product state, scheduling, review, apply, Action Center, public API behavior, or Goal Mode
- A translation of every OpenCode native event into the canonical worker protocol
- The OpenCode endpoint-family choice for correlated function-tool evidence. This redesign does not settle it. The other owners remain [Worker Runtime Sub-Agent Provenance And Inference Identity](20260711-worker_runtime_subagent_provenance.md), [Audit, Usage, And Evidence Records](20260703-audit_usage_evidence_records.md), and [LLM Gateway Responses API](20260526-llm_gateway_responses_api.md)

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-supply.md`
- `docs/core/sandbox.md`
- `docs/core/communication.md`

## Upstream Contract

The deployment pin is the OpenCode V2 release this adapter's implementation slice selects by probe and records in the `worker-runtimes` version manifest. This specification does not guess that pin. The examined tag `2.0.19` at commit `1fd016ef32286de9489b7b24f1029f52c49a27b3` is evidence, not the deployment pin. Official OpenCode `v1.18.1`, commit `99f638d8293f6985726ba509da602296c4963497`, installed as `opencode-ai@1.18.1`, is the removed image pin. The published server package name, its size, and whether it runs on the Node `24.18.0` bookworm image without Bun are not established. `@opencode/client` is not placed on the worker shim in a way that copies its dependency graph into `worker-common`.

The production client is `@opencode/client` against one supervised native server. `opencode run --format json` is not the contract. The server lives in the Sandbox, beside the adapter, not inside NanoCore.

Native permission prompts are disabled ([Sandbox](../core/sandbox.md), [full permission inside the Sandbox](../decisions/20260930-full_permission_inside_the_sandbox.md)). The field or client option that disables them is established by probe of the selected pin and is not named here. If a native permission request arrives anyway, the adapter selects an offered `reject_once` option, or cancels the prompt and records the request when none is offered. It never selects an allow option. Omitting `--auto` is not the permission story.

The V2 native server is required. It must not be exposed as NanoCore routes, and it must not imitate an OpenKit gateway.

## AEP Inputs Consumed

The shared Harness supplies the adapter with:

- adapter id `opencode`
- turn input
- worker working directory
- the admitted Thread-private retained home and separate ephemeral control slots
- the provider, model, endpoint, and credential bindings from the unique preferred LLM route
- the exact server ids from resolved AEP MCP supply, including automatically supplied built-in servers
- the two session-local loopback credentials, and no worker-control credential

The adapter does not resolve providers, credentials, models, permissions, or workspace policy on its own.

Server configuration is explicit and private. Ambient project configuration, auth content, default plugins, Claude Code prompts, external Skills, model fetches, sharing, updates, and LSP downloads stay disabled unless an accepted supply adds a specific one back. `OPENCODE_AUTH_CONTENT={}` must not be replaced by a stored provider credential. The V1 environment-variable spellings are not the contract. The requirement is the outcome: those ambient sources stay disabled. Native data under the retained home is persistent and is the resume store for sessions this version created.

Because the pinned V1 client loaded managed configuration after inline configuration and offered no disabling flag, `/etc/opencode` must not be able to override the adapter's explicit configuration. The V2 equivalent preserves that outcome. Until a probe shows a private configuration that cannot be overridden from that path, the image proves `/etc/opencode` is absent.

## Session Operations

`session.open` starts the server with explicit configuration and establishes or resumes the exact native session before work. The adapter inspects native automatic recovery before startup admission so unknown effectful work is not resumed outside authorization. `turn.start` reuses that session. Abort stops the Turn's work and leaves the session present. `turn.interrupt` reports the actual abort and does not close the session. `session.close` stops the binding's work, preserves native data, and does not delete the session as its method of release. A successor resumes the exact session. `session.inspect` reads the exact surviving host and native conversation, launches no work, and fails closed on an unknown or mismatched identity. `harness.drain` is the Harness admission fence. While admitted work and cleanup settle, this adapter refuses new `session.open` and `turn.start`. The Harness owns that fence. This adapter does not invent a native drain RPC.

The six operations are owned by [Worker Control Protocol](20260703-worker_control_protocol.md#harness-control-operations). This section maps each of them onto the open, inspection, prompt, interrupt, close, and admission-fence behavior above.

`session.open` carries `resume: { locator, digest } | null`. The raw reference stays in retained Sandbox storage outside the ephemeral control slots. Core stores the locator and the digest. Initial hosting is one server per binding until capability isolation for a shared server is proved. Closing a shared-host binding, once sharing exists, does not kill the server. A host restart invalidates every binding on that server. A transport loss and a NanoCore restart may each adopt the exact surviving binding, including its lineage, sequence, and lease, under the existing continuity and NanoHost proof contracts, with no duplicate effect. A binding that cannot be proved exactly is closed or fenced, and a successor resumes the native conversation. A NanoCore restart does not by itself end the binding. The server's own exit still ends the bindings that process hosted.

The live event stream is not a replayable transcript. A prompt response or an idle event is not proof that tool descendants stopped writing. Event subscription may be used inside the adapter and must not become a NanoCore API.

No environment variable, AEP extension, test option, or image diagnostic may replace the adapter-produced client operations. Tests inject a runner or a static test adapter without creating a production command override. NanoCore never constructs an OpenCode command. There is no shell-built command.

## Native Output Mapping

The adapter requires one correlated server terminal result for the admitted prompt. Native result content is limited to 16 MiB. Exceeding the bound fails collection closed. Unknown events are ignored and cannot complete a lifecycle predicate. Malformed records that prevent a trustworthy final result fail closed. A correlated success with no assistant text returns no assistant candidate. A native error outcome fails even when partial text exists.

Native OpenCode event names, tool-call records, provider payloads, and session objects remain inside the adapter. They are not added to `packages/worker-protocol` and do not enter NanoCore. The pinned V1 sequence `step_start`, `text`, `step_finish`, and `error` is not the product schema.

The adapter returns a normalized final assistant message and adapter-local diagnostics. The shared Harness writes schema-conformant candidate records, NanoCore alone validates and commits canonical product state, and the Harness retains at most a 16 KiB prefix from each of stdout and stderr for failure diagnostics before redaction. Live native token streaming into product Items is not supported.

## Control Mapping

- `turn.interrupt` aborts the Turn's work, reports the actual outcome, leaves the session present, and does not close the session.
- Native approval and question APIs are not product round trips.
- The server existing inside the Sandbox is not HTTP exposure to NanoCore.
- Exact native session resume is supported. Resume failure is explicit.

## Skills And MCP

OpenKit-managed MCP is server configuration on the dedicated server, for the exact selected supply, not a cwd-scoped ACP registry. Dedicated initial servers avoid sharing a live configuration scope across sessions. The adapter must not discover, install, connect directly, authorize, or broaden supply. [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md) owns the Gateway plane for external systems. In-Sandbox MCP is unrestricted.

The adapter declares whether the server lists tools again at Turn start. The implementation slice establishes that declaration by probe. When it does not, a changed supply is a setup change replaced by a successor AgentSession that resumes the native conversation. Narrowing and revocation apply at the next call as `capability_denied`.

## Provider And Credentials

The authored AgentManifest owns provider, model, credential, backend-capability, and network requirements. The resolved AEP owns the preferred logical model, exact allowed route set, credential bindings, and effective launch policy. The shared shim requires one unique route for the preferred model and passes only that route to the adapter. The adapter rejects an unsupported selected route and never introduces a provider default or fallback into NanoCore or the shared Harness.

For the trusted relay, the native provider id is the fixed slash-free adapter-owned id `openkit-worker-inference`. The model id is the exact admitted model id, serialized rather than interpolated. The base URL is `http://127.0.0.1:17892/inference/v1`. The AEP provider instance id remains NanoCore evidence and is not the native provider id. Configuration contains no credential value. The inference bearer is the session loopback credential, not `OPENKIT_WORKER_INFERENCE_TOKEN`. A request hook is the researched candidate for applying the current Turn's authority on each model request, including retry and compaction. It is not a proved mechanism, so this specification states the credential rule and does not treat the hook as qualified. If the probe fails, the credential rule still stands and the hook is not replaced by putting the upstream token in the environment.

Direct-provider routes are unsupported. Direct and otherwise unsupported routes fail closed before the session admits work, rather than receiving a fallback.

Mint, attribution, the Turn-barrier drain, and destruction of the two session loopback credentials belong to [Worker Agent Capability](20260703-worker_agent_capability.md). The adapter consumes the two supplied loopback bearers and never passes upstream or worker-control tokens to the native runtime. Native credential configuration stays isolated from configuration text, diagnostics, and evidence. An unsupported route fails closed. The native carrier for each bearer is qualified by probe and is not named here. Idle refusal, sibling refusal, and Turn-barrier behavior are consumed from that contract.

Declared runtime-env credentials are session-static. A changed declaration or value yields a successor AgentSession at the next Turn. A revocation interrupts and closes the binding at once.

## Manifest And Image Contract

The repository-owned OpenCode AgentManifest selects adapter id `opencode`, the deployment image `worker-runtimes`, native executable paths used by network policy, provider and credential requirements, and only capabilities proved by this specification. [Worker Execution Environment Images](20260721-worker_execution_environment_images.md) owns the image. This version starts from a new data root and does not read earlier-version data ([earlier-version data is not carried](../decisions/20260930-earlier_version_data_not_carried.md)).

The OpenCode install slice of that image installs the selected OpenCode V2 server, sets the generic shim as the image entrypoint, and runs as a non-root worker user. The image also contains Codex, Pi, and DeepSeek. Smoke verifies the selected native version, `/etc/opencode` absent or the proved equivalent, the shim, ambient-configuration isolation, and non-root identity. It does not verify JSON run mode. Image contents confer no adapter authority.

OpenCode-specific install commands, binary paths, configuration isolation, and version pins live only in the OpenCode AgentManifest, this adapter, this specification, and its tests, and in the OpenCode install slice of the one image.

## Failure Semantics

- Malformed or over-limit native output fails collection closed.
- A correlated success with no assistant text returns no assistant candidate.
- A non-zero or native error outcome fails even when partial text exists.
- Interruption wins over any partial final assistant content and does not by itself close the session.
- Abort mid-tool leaves the session present. Close that cannot drain is not how release is defined. Release preserves native data.
- Worker-control failure stops that binding's work through the shared Harness.
- Missing or incompatible native state for a session this version expects fails resume explicitly, with no fresh-session fallback.
- The Harness preserves the retained home. Exact resume authority lives outside the ephemeral control slots.

## Capability Declaration

The authored manifest is the sole launch-time capability declaration. Adapter conformance and image smoke prove that the manifest advertises only the following supported behavior. Adapter conformance does not return a second capability declaration.

- Resident V2 session continuity and exact resume: supported
- Workspace edits inside declared writable roots: supported
- Normalized final assistant candidate content: supported
- Abort that reports the actual outcome: supported
- MCP on the dedicated server for selected supply: supported
- Live native token streaming into product Items: not supported
- Native approval or question round trips: not supported
- NanoCore exposure of the server port: not supported

## Tests

Required adapter tests cover:

- Credential-value absence, the fixed slash-free provider id, exact model id serialization, and direct-route rejection before the session admits work
- Unknown-event tolerance, the 16 MiB and 16 KiB bounds, and redacted diagnostics
- Ambient-configuration isolation, including disabled project config, default plugins, external Skills, sharing, updates, model fetches, and LSP download, and retained home bytes preserved at close
- A server started with explicit configuration, the required plugin loaded without ambient discovery, a session aborted mid-tool, and the session still present afterward
- Dedicated-server MCP grants do not leak across sessions. The live event stream is not treated as a transcript
- A supply change between two Turns either shows the new supply on the second Turn or follows the probed setup-change successor. The check reads the model-visible schema
- Fail-closed native permissions
- `/etc/opencode` cannot override explicit configuration
- No production command override
- Inspection of the exact surviving host and native conversation, rejection of an unknown or mismatched identity with no work launched, and `harness.drain` refusing new `session.open` and `turn.start` while admitted work and cleanup settle

The shared qualification cases in [Codex Worker Adapter](20260716-codex_worker_adapter.md#tests) apply to this runtime on the V2 server and `@opencode/client`. `opencode run` and ACP mode are not alternate passing interfaces.

Required image smoke covers the selected OpenCode version, the generic shim entrypoint, non-root user, and absence of `/etc/opencode` or the proved equivalent.

## Implementation Evidence And Limit

The paragraphs below record the V1 `run` implementation and the 2026-07-21 smoke. They are historical evidence of that path. The accepted design replaces it. They are not the current acceptance bar.

The OpenCode `1.18.1` one-shot adapter, static registry entry, authored manifest, pinned worker image, `prepare` and `collect` tests, mode-selected durable interrupt, one-start Harness guard, inspection and private-interrupt rejection, terminal binding close, and refreshed image smoke are implemented. This establishes the local Turn-private command path and not resident session continuity. The refreshed 2026-07-21 arm64 image builds locally and passes its complete smoke. The earlier minimal arm64 image passed stock unpatched OpenShell `0.0.80` create, upload, generic-shim dry-run, and delete on A1, but that historical run is not refreshed-image OpenShell evidence.

This dry run proves image contents, adapter preparation, stock OpenShell containment, upload, and cleanup for those bytes. An older acceptance note required one exact-candidate real-provider success and one Turn whose interrupt crosses NanoCore restart without native reuse. That note is historical for the removed path. It is not the resident adoption rule. The earlier dry run does not prove resident server behavior.

## Acceptance

This adapter is clean only when deleting it removes all OpenCode command and event knowledge without changing NanoCore, the shared Harness contract, or canonical worker schemas. The deployment image is shared and is not deleted with the adapter.

## Upstream Evidence

The links below document the removed `1.18.1` pin. They are not the V2 deployment pin.

- `https://github.com/anomalyco/opencode/commit/99f638d8293f6985726ba509da602296c4963497`
- `https://github.com/anomalyco/opencode/blob/99f638d8293f6985726ba509da602296c4963497/packages/web/src/content/docs/index.mdx`
- `https://github.com/anomalyco/opencode/blob/99f638d8293f6985726ba509da602296c4963497/packages/opencode/src/cli/cmd/run.ts`
- `https://github.com/anomalyco/opencode/blob/99f638d8293f6985726ba509da602296c4963497/packages/web/src/content/docs/server.mdx`

## Related Documents

- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260721-worker_execution_environment_images.md`
- `docs/specs/20260716-codex_worker_adapter.md`
