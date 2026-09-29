---
status: Accepted
implementation: Partial
kind: boundary
updated: 2026-09-30
---
# Codex Worker Adapter

## Generic Volume Retention Amendment

[Persistent Worker Volumes](20260910-persistent_worker_volumes.md) owns complete opaque data/home volumes and supersedes this adapter's deletion of native data at ordinary Turn or AgentSession close. The adapter locates its data directory in its admitted stable Thread-private home and leaves all contents intact, without a list of known filenames. Generated launch and control material remains in separate ephemeral roots. Opening or closing a native binding must not recursively erase the retained data directory; closing still invalidates the exact binding and proves writer absence. Retained native histories, memory, configuration and unknown files do not select a conversation or grant tools or credentials.

App Server v2 operations, event translation, and feature restrictions remain owned here. Whole-volume retention alone does not discover a session, enable hooks or saved-session discovery, or grant tools, credentials, or ambient configuration as launch authority. Exact resume uses the retained reference under [AgentSession](../core/agent-session.md). A resume that is not the exact thread fails explicitly and never falls back to a fresh conversation, an empty conversation, or a transcript replay. The existing runtime-state deletion implementation is not yet aligned with this amendment.

## Summary

The Codex Worker Adapter speaks App Server v2 over Sandbox-local stdio, with protocol types matched to the selected binary, for one resident binding of a Thread's retained native conversation. It translates that server's events into the shared OpenKit Harness result, including optional rollout evidence only through the provenance owner.

The adapter is worker-side integration code. It is not a NanoCore runtime, transport, policy engine, product model, or provider owner. It does not use `@openai/codex-sdk`, `codex exec`, or `codex-acp`. It does not embed the engine in the Integration and Harness process. It does not use ACP, even as an internal event model ([four native runtime adapters](../decisions/20260929-four_native_runtime_adapters.md), [downward contract](../decisions/20260929-downward_common_runtime_contract.md)).

## Owns

- Codex session-local state, native thread identity, and the restricted resume reference outside the disposable control root
- App Server v2 session configuration for the trusted relay and the exact resolved MCP servers, including the built-in servers
- Translation of App Server events into the shared Harness result
- The provenance attachment boundary; the evidence projection is owned by [Worker Runtime Subagent Provenance](20260711-worker_runtime_subagent_provenance.md)
- Codex-specific version and native event compatibility tests
- Codex-specific failure mapping and conformance evidence for manifest-declared capabilities

## Does Not Own

- Child-process supervision beyond the native process this adapter asks the shared Harness to supervise, or process-group cleanup
- Worker-control readiness, heartbeat, polling, sequencing, or authentication
- Canonical transcript persistence or NanoCore event import
- AEP resolution, provider selection, credential grants, or network authorization
- Workspace snapshot, review, apply, or durable product state
- Goal Mode, Action Center, scheduling, placement, or backend lifecycle
- Minting, Turn binding, and destruction of the session loopback credentials, which [Worker Agent Capability](20260703-worker_agent_capability.md) owns

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-supply.md`
- `docs/core/sandbox.md`
- `docs/core/communication.md`

## Upstream Contract

The deployment pin is the Codex release this adapter's implementation slice selects by probe and records in the `worker-runtimes` version manifest. This specification does not guess that pin. The examined Codex `0.159.0` commit `687a119f0fcaace47e1f1abcc77cec6c813fd6da` is evidence, not the deployment pin. Codex CLI `0.153.4` is the historical `codex exec` image pin, not the App Server deployment pin.

The production interface is one supervised App Server v2 process per binding, over Sandbox-local stdio, until shared-host isolation is proved. Protocol types match the selected binary. The schema package is refreshed to that binary's generated schema. Exec command lines, `implementationValues`, and `--output-last-message` are not the contract.

A thread id selects the exact native thread. Neither `--last`, title search, cwd search, sibling state, nor ambient Codex home is permitted. An ephemeral mode must not drop persistence under the AgentSession-private `CODEX_HOME`, because that persistence is what a later server instance resumes. Ambient user config, rules, hooks, and saved-session discovery are not launch authority.

Native permission prompts are disabled. The worker has full permission inside the Sandbox ([Sandbox](../core/sandbox.md), [full permission inside the Sandbox](../decisions/20260930-full_permission_inside_the_sandbox.md)). If a native permission request arrives anyway, the adapter selects an offered `reject_once` option, or cancels the prompt and records the request when none is offered. It never selects an allow option. Turning prompts off grants nothing beyond what the Sandbox enforces, and it must never be used to create a host runtime path. Native approval requests, questions, steering, and follow-up remain unsupported. A native effect that needs approval and has no Gateway operation stays unsupported.

## AEP Inputs Consumed

The shared Harness supplies the adapter with:

- adapter id `codex`
- turn input
- worker working directory
- the admitted retained Thread-private data root and a fresh AgentSession-private control binding
- the provider, model, endpoint, and credential bindings from the unique preferred LLM route selected by the shared shim
- the exact server ids from resolved AEP MCP supply, including automatically supplied built-in servers; the built-ins require no manifest selection
- optional native provenance declaration
- the two session-local loopback credentials, and no worker-control credential

The adapter must not read NanoCore private storage or invent missing provider, model, policy, or credential decisions.

`session.open` without a resume reference starts or attaches the supervised server and establishes the exact native thread before work. `session.open` with the retained reference resumes that thread and validates the native result before any work. `session.open` carries `resume: { locator, digest } | null`. The raw thread id stays in retained Sandbox storage outside the disposable control root. Core stores the locator and the digest. The raw UUID remains only in that retained adapter state and is never a product field, ordinary diagnostic, command result, or authorization input.

For each exact server id in resolved MCP supply, the adapter projects only that id onto App Server session MCP aimed at the loopback class `http://127.0.0.1:17892/capabilities/mcp/<id>`, authenticated with the capability loopback credential. The raw credential never enters argv. Unselected executable MCP entries and hooks remain disabled. Retained data and configuration do not widen current authority, and sibling AgentSessions remain separately addressed. The adapter must not discover, install, connect directly, authorize, or broaden supply. An empty manifest MCP selection does not disable the capability plane: resolved supply still includes the built-in servers supplied by [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md). A missing capability loopback credential fails `session.open` before native work. [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md) owns the Gateway plane. In-Sandbox MCP servers are the worker's under the Sandbox rule and are not an approval surface.

The adapter declares whether the Codex MCP client lists tools again at Turn start. The implementation slice establishes that declaration by probe, and this specification does not invent the answer. When the runtime does not list tools again, a changed supply is a setup change: [AgentSession](../core/agent-session.md) replaces the live binding with a successor that resumes the native conversation. Narrowing and revocation apply at the next call as `capability_denied`. The Turn boundary order is fence the earlier Turn, admit and bind the new Turn, discover tools, verify the snapshot the model will see, then prompt. A researched `config/mcpServer/reload` method is not a settled requirement.

## Session Operations

The Harness owns lifecycle sequencing. The adapter owns native thread identity, event translation, and Codex configuration.

- `session.open` starts or attaches one supervised App Server for this binding and establishes or resumes the exact thread before work.
- `turn.start` uses the current binding, one active Turn, and current authorization. It does not launch a new process per Turn.
- `turn.interrupt` reports the actual native cancellation outcome and does not close the session.
- `session.inspect` distinguishes the surviving server and thread from a replacement or an unknown or mismatched identity, and launches no work.
- `session.close` stops that binding's work, preserves `CODEX_HOME`, removes the ephemeral control binding and Turn-local outputs, and returns exact writer absence proof for that binding.
- `harness.drain` is the Harness admission fence. While admitted work and cleanup settle, this adapter refuses new `session.open` and `turn.start`. The Harness owns that fence. This adapter does not invent a native drain RPC.

The six operations are owned by [Worker Control Protocol](20260703-worker_control_protocol.md#harness-control-operations). This section maps each of them onto the native thread behavior above.

Initial hosting is one server per binding until shared-host isolation is proved. Until that proof, close stops that binding's server. Once sharing is proved, closing one binding does not kill the server or delete native data, and a worker-control failure stops that binding's work without killing sibling bindings. A host restart invalidates every binding that host served. A transport loss and a NanoCore restart may each adopt the exact surviving binding, including its lineage, sequence, and lease, under the existing continuity and NanoHost proof contracts, with no duplicate effect. A binding that cannot be proved exactly is closed or fenced, and a successor resumes the native conversation. A NanoCore restart does not by itself end the binding.

No environment variable, AEP extension, test option, or image diagnostic may replace the adapter-produced native operations. Tests inject a process runner or a static test adapter without creating a production command override.

A correlated native terminal outcome and an exact thread identity are required before the Turn is accepted. A terminal native result is not proof that background tools stopped writing. Unsubscribe or detach is not by itself proof that work stopped. Archive or delete is not a substitute for close while retaining context.

## Logical Model Patch Capability

OpenKit logical model IDs may be unknown to the pinned Codex model catalog. Whether the selected App Server still needs the unknown-model fallback descriptor, including `apply_patch_tool_type: freeform`, is established by the implementation slice's probe. If the selected server accepts the logical model without that descriptor, the mechanism is absent. If it still needs the descriptor, the criteria below apply without `--output-last-message`, exec argv, or `model_catalog_json` spelled as an exec flag.

This is native tool presentation, not model selection, context policy, or new filesystem permission. The AEP's exact logical slug, trusted Gateway route, and Sandbox authority remain unchanged. No unrelated model's catalog entry may be substituted. The adapter never accepts a caller-supplied native catalog, places the descriptor in retained `CODEX_HOME`, or adds a shared Harness file envelope. The descriptor contains no credentials, Provider identity, user input, or permission grants. Creation and validation failure prevents the Turn. A fresh Turn creates a fresh descriptor when the mechanism is required. Stale or missing prior descriptors are never discovered or reused. Tests must cover first establishment and exact resume, private creation and cleanup, unchanged model, route, and credentials, and pinned native freeform patch exposure when the mechanism remains. A bounded real native edit is required for Worker-image qualification. Operation assertions alone do not prove that the pinned runtime exposes or executes the tool.

## Native Output Mapping

The final assistant response is the correlated App Server terminal result, not a `--output-last-message` file. The adapter validates that result, applies the shared 16 MiB bound, decodes UTF-8, trims surrounding whitespace, and returns either one assistant message or no message together with the exact native-handle proof.

App Server events are not imported directly into NanoCore product state. When runtime provenance is enabled, the evidence projection is owned by the provenance specification. The accepted design replaces exec JSONL stdout capture. The retention boundary in Provenance stays here.

Outside the separately bounded streaming provenance path, native result content is limited to 16 MiB. The shared process runner retains at most a 16 KiB prefix from each of stdout and stderr for failure diagnostics before redaction.

Malformed native events may invalidate provenance evidence, but they must not bypass candidate terminal classification or cause NanoCore to accept native Codex schemas.

The adapter returns normalized assistant content or a product-safe failure classification. The shared Harness emits schema-conformant candidate records, and NanoCore alone validates and commits canonical Items and terminal state. Live native token streaming into product Items is not supported.

## Control Mapping

The target OpenKit worker envelope is one open Codex AgentSession with zero or more sequential Turns and at most one active Turn in that AgentSession. The Turns are not per-Turn `codex exec` processes.

- `session.open` creates the private state root, starts or attaches the supervised server, and establishes or resumes the exact thread before work.
- `turn.start` submits the Turn on that resident thread.
- `turn.interrupt` reports the actual cancellation outcome for that AgentSession's work and does not close the session.
- `session.inspect` and `session.close` use the fixed adapter operations above.
- Native approval requests, questions, steering, and follow-up remain unsupported.

Another resident AgentSession belongs to another Thread and has a distinct private `CODEX_HOME`, native handle, server process until sharing is proved, Turn slots, the two loopback credentials, and cleanup proof even when it selects the same Agent, image, model, or provider. The adapter never selects an AgentSession by `--last`, title, cwd, sibling state, or ambient Codex home.

## Skills And MCP

NanoCore resolves approved static Skill and selected MCP supply into the AEP. The Codex adapter projects exactly the resolved MCP server ids through the fixed authenticated loopback URLs above. NanoCore still owns catalog resolution, authorization, credentials, transport, usage, and audit, and the adapter must not discover, install, connect directly, authorize, or broaden supply. An empty manifest MCP selection does not disable the capability plane: resolved supply still includes the built-in servers supplied by [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md). A missing capability loopback credential fails `session.open` before native work. A reload or re-list, when the probed declaration says the client lists tools again, happens at a Turn boundary, not mid-Turn.

## Provider And Credentials

The authored AgentManifest owns provider, model, credential, backend-capability, and network requirements. The resolved AEP owns the preferred logical model, exact allowed route set, credential bindings, and effective launch policy. NanoCore performs that resolution but does not own a second native-runtime configuration.

The shared shim requires one unique AEP route for the preferred model and passes only that route to the adapter, while native route projection remains adapter-specific. Neither NanoCore nor the shared Harness infers Codex provider configuration or falls back to another model. The adapter rejects any selected route whose exact endpoint, credential binding, model, or wire protocol the selected App Server cannot represent.

For the trusted NanoCore relay, the adapter uses the fixed adapter-owned provider id `openkit-worker-inference`. It never projects an arbitrary AEP provider id into Codex. Web search stays disabled. The base URL stays `http://127.0.0.1:17892/inference/v1`. The wire API stays Responses-only, and `requires_openai_auth` stays false. If the selected App Server cannot represent that route, the route fails closed before the native Turn is admitted. The inference bearer is the session loopback credential, not `OPENKIT_WORKER_INFERENCE_TOKEN`. The capability bearer is the capability loopback credential, not `OPENKIT_WORKER_CAPABILITY_TOKEN`. The native field or SDK call that carries each loopback credential is established by probe of the selected pin and is not named here. Codex has no per-Turn credential field, and a changed parent environment must not be assumed to update a running server.

Mint, attribution, the Turn-barrier drain, and destruction of the two session loopback credentials belong to [Worker Agent Capability](20260703-worker_agent_capability.md). The collection check of those credentials belongs to [Workspace Synchronization](20260703-workspace_synchronization.md#snapshot-chain). The adapter consumes the two supplied loopback bearers and never passes upstream or worker-control tokens to the native runtime. Native credential configuration stays isolated from argv, native configuration text, diagnostics, and evidence. An unsupported route fails closed. The native carrier for each bearer is qualified by probe of the selected pin and is not named here. Idle refusal, sibling refusal, and Turn-barrier behavior are consumed from that contract. The selected server supports only the Responses wire API through the inference projection, so a Chat-Completions-only relay is unsupported.

Direct-provider routes are unsupported because the current AEP route does not carry a separately proved Responses wire protocol and exact credential target for truthful Codex projection. Direct, Chat Completions, Anthropic Messages, Gemini, and other non-relay routes fail closed before the native Turn is admitted. The adapter never substitutes a direct route for the trusted relay, and neither NanoCore nor the shared Harness knows a Codex config-file schema.

Declared runtime-env credentials are session-static. A changed declaration or value yields a successor AgentSession at the next Turn. A revocation interrupts and closes the binding at once.

## Manifest And Image Contract

The repository-owned Codex AgentManifest selects adapter id `codex`, the deployment image `worker-runtimes`, the runtime version recorded by this slice, native executable paths used by network policy, trusted-relay requirements, and only capabilities proved by this specification. [Worker Execution Environment Images](20260721-worker_execution_environment_images.md) owns the image. This version starts from a new data root and does not read earlier-version data ([earlier-version data is not carried](../decisions/20260930-earlier_version_data_not_carried.md)).

The deployment image installs the generic worker shim and the selected Codex binary in the Codex install slice, sets the generic shim as its entrypoint, and runs as a non-root worker user. It also contains Pi, OpenCode V2, and DeepSeek. Its smoke check verifies the selected native version, the shim, non-root identity, and expected worker filesystem layout. It does not verify `codex exec` machine-readable flags. Image contents confer no adapter authority.

Codex-specific install commands, binary paths, state directories, auth paths, and version pins live only in the Codex AgentManifest, this adapter, this specification, and its tests, and in the Codex install slice of the one image. They do not live in the other adapters.

## Provenance

Codex runtime provenance is optional and governed by [Worker Runtime Subagent Provenance](20260711-worker_runtime_subagent_provenance.md).

The provenance owner owns the evidence projection from App Server events. This adapter owns the attachment boundary: when the AEP enables provenance, the adapter makes the native rollout evidence available to that owner. The shared Harness owns lifecycle timing and failure cleanup. NanoCore owns evidence verification and import. The accepted design replaces streaming `codex exec --json` stdout into the provenance primary stream.

The AgentSession-private rollout forest is required native continuity state and remains across `session.close` as retained data, independent of whether S33 product-safe provenance export is enabled. S33 controls only bounded evidence projection into declared outputs. It does not control native state persistence. Turn-private transient capture files are removed after collection, while `session.close` revokes its binding after exact writer absence without deleting the retained `CODEX_HOME`.

No other adapter is required to imitate Codex rollout files. Possession of rollout files grants no execution authority.

## Failure Semantics

- A correlated terminal result with no assistant text returns a successful normalized result with no assistant candidate.
- A present native result that is not readable UTF-8 or exceeds 16 MiB fails collection closed.
- A non-zero or failed native outcome returns a failed adapter classification with bounded, redacted stdout and stderr summaries even when partial assistant content exists.
- Cancellation reports the actual outcome and wins over partial assistant content, and does not by itself close the session.
- Missing, malformed, multiple, changed, or sibling thread identity fails the Turn and makes the binding non-reusable until exact cleanup.
- Missing or conflicting same-thread rollout metadata, exact resume refusal, or a resume that reports another thread drains the AgentSession binding and never falls back to a new conversation or an empty one.
- A missing, corrupt, mismatched, or version-incompatible thread fails explicitly, with no transcript replay and no discovery.
- Provenance capture failure invalidates provenance evidence and fails according to the accepted provenance contract.
- Worker-control failure remains a shared Harness failure and stops that binding's Codex work.

## Capability Declaration

The authored manifest is the sole launch-time capability declaration. Adapter conformance and image smoke prove that the manifest advertises only the following supported behavior. Adapter conformance does not return a second capability declaration.

- Resident exact-thread continuity, including resume on a new server instance: supported
- Workspace edits inside declared writable roots: supported
- Normalized final assistant candidate content: supported
- Interrupt that reports the actual outcome and does not close the session: supported
- Live native token streaming into product Items: not supported
- Native approval or question round trips: not supported
- Steering and follow-up: not supported
- Optional runtime provenance: supported only through the provenance owner and the accepted AEP feature

## Tests

Required adapter tests cover:

- Credential-value absence from argv, native configuration text, diagnostics, and evidence, and direct-route rejection before the native Turn is admitted
- Rejection of any environment variable, AEP extension, or image diagnostic that would replace the adapter-produced native operations
- Distinct-Thread AgentSession-private `CODEX_HOME` roots, rejection of two current bindings for one Thread, ignored ambient config and rules, exact thread establishment, exact resume by a later server, sibling rejection, and close preserving `CODEX_HOME` while removing only the ephemeral control binding
- Rejection of `--last`, title, cwd, ambient-home, missing-handle, conflicting-handle, and unsupported interactive capability paths
- The 16 MiB native-result bound and the 16 KiB redacted diagnostic prefix per stream
- Unknown-model descriptor behavior only for the branch the selected binary still requires, including no caller-supplied catalog and no descriptor in retained `CODEX_HOME`
- Two Turns on one thread against a synthetic Responses provider, a new server resuming that thread, and an unsubscribe while a sibling thread runs
- The native process never holds the upstream token. Idle refusal, sibling refusal, and the Turn-barrier drain are consumed from [Worker Agent Capability](20260703-worker_agent_capability.md). Release does not affect a sibling once sharing is in the test. A terminal Turn result is not proof that background tools stopped
- Inspection distinguishes the surviving server and thread from a replacement or an unknown identity, launches no work on a mismatched identity, and `harness.drain` refuses new `session.open` and `turn.start` while admitted work and cleanup settle
- A supply change between two Turns either shows the new supply on the second Turn or follows the probed setup-change successor. The check reads the model-visible schema
- Fail-closed native permissions: `reject_once`, or cancel and record, never allow
- Shared Harness tests for `turn.interrupt` reporting the actual outcome on cancellation mid-model and mid-tool, without closing the session by itself

Required image smoke of `worker-runtimes` covers the selected `codex` version, the generic shim entrypoint, non-root user, and adapter selection `codex`. It does not cover `codex exec` help.

The following qualification cases apply to this runtime on its accepted interface. A mocked adapter proves the Harness only. Matching UI text is not context continuity. One runtime's pass does not qualify another.

- Two consecutive Turns in one AgentSession keep the same native conversation, and the second model request contains the prior context.
- Close releases the binding and its owned work, preserves context and files, and, once a shared host is enabled, leaves the server and sibling AgentSessions working.
- A later instruction creates a different AgentSession and resumes the same native conversation. The old binding cannot still control it.
- A transport loss and a NanoCore restart may each adopt the exact surviving binding when lineage, sequence, and lease match, including `awaiting-reconnect`, and that adoption preserves the execution without replaying work. A binding that cannot be proved exactly is closed or fenced, and a successor resumes natively.
- A runtime-host crash ends the old AgentSession. Recovery creates a new one and does not duplicate the interrupted instruction's effects or claim effect rollback.
- Closure racing with new input never produces two authoritative writers for one Thread.
- Compaction before close survives resume, with only observed lineage recorded and no duplicated canonical messages.
- With no manifest-selected MCP server, the runtime still exposes the automatically supplied `openkit-work` tools through its authenticated capability route, and omission of the capability loopback credential fails before native work.
- Missing or corrupt resume data fails explicitly and does not open an empty conversation labeled as continued.
- Idle refusal, sibling refusal, and the Turn-barrier drain of loopback credentials are consumed from [Worker Agent Capability](20260703-worker_agent_capability.md). Upstream tokens never sit in the native environment.
- Two conversations on one shared server, if that hosting is enabled, stay independent. A shared-server failure invalidates every binding that server hosted.
- Late output or a permission request from a released binding cannot attach to its successor.
- Web and the public Skill show the same running, reconnecting, closed, and resume-failed outcomes.
- Where a load operation exists, it does not restore a pending RPC. There is no transparent recovery of in-flight work.
- Workspace collection does not claim stability while a relevant writer remains active. This adapter does not treat process exit as the collection gate. Collection is owned by [Workspace Synchronization](20260703-workspace_synchronization.md).

## Implementation Evidence And Limit

The paragraphs below record the `codex exec` implementation and the image observations of 2026-07-21, 2026-09-05, and 2026-09-06. They are historical evidence of those bytes. The accepted design replaces this path with resident App Server v2. Nothing in the running app depends on `packages/codex-app-server-schema` beyond version-string comparison for the exec pin. The accepted design refreshes that package to the selected binary's generated schema and deletes exec `implementationValues` with the exec path.

The Codex `0.153.4` session-continuity adapter, static registry entry, authored manifest, pinned worker image definition, five-operation adapter tests, retained AgentSession-private state, exact first-Turn handle binding, exact-UUID resume, inspection, close, and multi-AgentSession Harness integration are implemented and pass local checks. OpenCode and Pi retain their per-Turn launch paths. The 2026-07-21 arm64 image build and complete smoke, and the earlier minimal arm64 OpenShell `0.0.80` create, upload, generic-shim dry-run, and delete on A1, are historical evidence for the previous Codex `0.144.1` image contents. On 2026-09-05 this worktree built and smoked unique local tag `openkit/worker-codex:codex-pi-refresh-20260905` on Docker Engine 29.5.2 linux/aarch64 (image id `sha256:2fdd17abc6d39b87227ee0a6dbbf1890d63949b909a3e9758f576f932fca161d`, smoke exit 0, native version `codex-cli 0.153.4`). For that unique-tag observation, refreshed stock OpenShell, provider, interrupt, reconnect, recovery, amd64 cross-build, and worker-lifecycle evidence for those image bytes remained unobserved.

This local unique-tag smoke proves image contents and adapter dry-run for the 0.153.4 pin. It does not prove a real-provider turn, worker-control readiness, heartbeat, interruption, reconnect, or recovery lifecycle; those remain acceptance obligations of their owning specifications and change packages. Consumed-surface dispositions and per-file generated-schema checksums for this pin live in `packages/codex-app-server-schema/metadata.json`. Codex `0.153.4` `exec resume` does not accept `--cd`; first-turn still passes `--cd`, and resume relies on the Harness child working directory. That argv difference is an `adapted` consumed-surface disposition of the removed exec path, not a selectable-pin closure.

On 2026-09-06 the current `0.153.4` pin passed both-architecture catalog image builds and smokes and three-leaf stock OpenShell packaging. Exact A2 Codex image `sha256:8bc5033350edebe85293e8528452c09ac78637ea55915bed7878cdc3b72387a9` passed real-provider readiness, heartbeat progress, same-lineage NanoCore restart and reconnect and completion in F1 attempt 9 (receipt SHA-256 `0e02678943b2b70e526bdf217b32c0fa4e3dcafcc3c01697cc8c58c3cf54b97b`). Public interruption on corrected App source `ec9490e6a6d53f2b9d19e968754f754938b98c9e`, App image `sha256:5cd666ef358a138f404d4b3abf4da0041e27493faf818ee06780258654040203`, passed on `ws_24` / `th_27`: native `interrupted` / `aborted`, Core Turn `interrupted`, Task `cancelled`, exact lease released, backend cleaned, and generation 36 ready, fenced, and fresh-empty. Its receipt SHA-256 is `40ed7f8be04812ababededfa23102136426f4602a418419ec3b92808c94f5691`. These observations are historical for the exec pin. They are not the App Server acceptance bar. Optional provenance advertisement and general NanoHost release qualification remain separately owned.

## Acceptance

This adapter is clean only when deleting it removes all Codex-native protocol, output, and provenance knowledge without changing the shared worker contract or NanoCore product and governance core. The deployment image is shared and is not deleted with the adapter.

## Related Documents

- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
- `docs/specs/20260721-worker_execution_environment_images.md`
- `docs/specs/20260930-deepseek_worker_adapter.md`
