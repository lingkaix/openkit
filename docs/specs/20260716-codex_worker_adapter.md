---
status: Accepted
implementation: Partial
kind: boundary
updated: 2026-10-05
---
# Codex Worker Adapter

## Generic Volume Retention Amendment

[Persistent Worker Volumes](20260910-persistent_worker_volumes.md) owns complete opaque data/home volumes and supersedes this adapter's deletion of native data at ordinary Turn or AgentSession close. The adapter locates its data directory in its admitted stable Thread-private home and leaves all contents intact, without a list of known filenames. Generated launch and control material remains in separate ephemeral roots. Opening or closing a native binding must not recursively erase the retained data directory; closing still invalidates the exact binding and proves writer absence. Retained native histories, memory, configuration and unknown files do not select a conversation, grant OpenKit credentials, or grant external model, tool, provider, or network authority; admitted in-Sandbox configuration follows Retained Native Home And Configuration Authority below.

App Server v2 operations, event translation, and feature restrictions remain owned here. Whole-volume retention alone does not discover a session, enable saved-session discovery, or grant credentials or ambient configuration as external launch authority. Exact resume uses the retained reference under [AgentSession](../core/agent-session.md). A resume that is not the exact thread fails explicitly and never falls back to a fresh conversation, an empty conversation, or a transcript replay. The implementation retains the stable native home; qualification limits are recorded below.

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

Codex starts with full access and full permission inside the Sandbox, with native permission prompts disabled ([Sandbox](../core/sandbox.md), [Sandbox full-capability rulings](../decisions/20261001-sandbox_full_capability_rulings.md)). An unexpected native permission request receives the pin's shortest-lived allow decision by default and does not interrupt the Turn. The adapter retains its existing deny-capable response path for future user-configurable policy, without introducing a policy setting now. Authored native deny rules remain the user's choice and are preserved. Native questions, steering, follow-up, and interactive approval round trips remain unsupported. External effects continue through Gateway approval and audit, and full native permission grants no authority beyond Sandbox storage and network containment.

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

A new `session.open` performs the native handshake and reports `pending` until the first Turn has established the exact conversation and written resumable native state. A resumed `session.open` proves the exact retained conversation before reporting `ready`, without contacting the capability loopback. The binding applies the first Turn's working directory and MCP supply once after that Turn is bound; a later incompatible supply change requires a successor AgentSession. `session.open` carries `resume: { locator, digest } | null`. The raw thread id stays in retained Sandbox storage outside the disposable control root. Core stores the locator and the digest. The raw UUID remains only in that retained adapter state and is never a product field, ordinary diagnostic, command result, or authorization input.

For each exact server id in resolved MCP supply, the adapter projects only that id onto App Server session MCP aimed at the loopback class `http://127.0.0.1:17892/capabilities/mcp/<id>`, authenticated with the capability loopback credential. The raw credential never enters argv. Unselected OpenKit-managed external MCP entries receive no managed projection; independently configured local MCP follows Retained Native Home And Configuration Authority, and native plugins and hooks follow the same in-Sandbox support boundary. Retained data and configuration do not widen current authority, and sibling AgentSessions remain separately addressed. The adapter must not discover, install, connect directly, authorize, or broaden supply. An empty manifest MCP selection does not disable the capability plane: resolved supply still includes the built-in servers supplied by [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md). A missing capability loopback credential fails `session.open` before native work. [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md) owns the Gateway plane. In-Sandbox MCP servers are the worker's under the Sandbox rule and are not an approval surface. Each managed server is configured with `default_tools_approval_mode` set to approve so tool calls proceed without client approval, consistent with the full-permission rule above, and [Operation Definition](20261002-operation_definition.md) recommends that same setting for external Codex installations.

The adapter declares whether the Codex MCP client lists tools again at Turn start. The implementation slice establishes that declaration by probe, and this specification does not invent the answer. When the runtime does not list tools again, a changed supply is a setup change: [AgentSession](../core/agent-session.md) replaces the live binding with a successor that resumes the native conversation. Narrowing and revocation apply at the next call as `capability_denied`. The Turn boundary order is fence the earlier Turn, admit and bind the new Turn, discover tools, verify the snapshot the model will see, then prompt. A researched `config/mcpServer/reload` method is not a settled requirement.

### Retained Native Home And Configuration Authority

`CODEX_HOME` is the admitted stable Thread-private native data home. Its complete opaque contents remain retained across ordinary Turn close, AgentSession close, and compatible successor creation. The adapter neither overwrites nor removes authored native configuration. It does not generate a base configuration file in that retained home; adapter-owned non-secret launch values use fixed invocation options or native in-memory configuration, and loopback credentials use only the qualified in-memory carrier.

Native configuration and rules inside the admitted Sandbox home and working roots MAY influence local execution within the already admitted Sandbox authority. They do not select a conversation, establish an AgentSession, authorize an external effect, select an unadmitted model/provider route, or supply OpenKit credentials. Current AEP resolution and adapter-owned bindings govern the preferred logical model, exact allowed logical-model set, external MCP projection, Gateway endpoints, and current loopback credentials. A retained preference cannot replace those bindings. Native permission prompts remain disabled; OpenKit adds no restriction on local capability that does not protect an owned boundary.

Only AEP-selected external MCP server ids receive the adapter's authenticated Gateway projection. Independently configured in-Sandbox MCP servers are Sandbox execution under the Sandbox owner, not an additional OpenKit approval surface. They receive no additional external authority or adapter-provisioned Gateway credentials by being present in native configuration. External traffic follows [Sandbox](../core/sandbox.md); native configuration grants no additional external authority.

Image defaults reach `CODEX_HOME` by native layering where the selected pin supports it, otherwise by initializing a fresh home, under [Persistent Worker Volumes](20260910-persistent_worker_volumes.md#native-defaults-and-private-home-placement). Current AEP-selected Skills are projected separately from independently configured native Skills; replacing the selected set, including with an empty set, does not remove local ones.

These rules replace the blanket prohibition on ambient user configuration and rules as local inputs, and the blanket disabling of unselected executable MCP entries, only for execution inside the admitted Sandbox. References in this specification to discovery, direct connection, or supply broadening continue to prohibit bypass of the external AEP/Gateway plane. Configuration outside the admitted Sandbox roots is not loaded. Authored native plugins and hooks load through the pin's own loader and may act during a Turn. OpenKit applies protected bindings at setup; plugin or hook code that later rewrites a protected binding is outside supported supply, with no prevention promise. Saved-session discovery remains unsupported. The governing ruling is [Sandbox Full-Capability Rulings](../decisions/20261001-sandbox_full_capability_rulings.md).

Protected-id HTTP MCP collisions apply the managed URL and credential header last, enable the supplied binding, preserve authored files, and allow the Turn to proceed. A credential-free warning naming the id travels on the existing adapter result diagnostics, including completed results. Codex at the current pin recursively merges MCP entries and cannot overlay an authored stdio or other non-HTTP entry without breaking the protected binding. Only those non-HTTP collisions, whether enabled or disabled, fail Turn preparation closed before native thread configuration or prompting. The error envelope carries a warning naming the id and an actionable message asking the user to rename their entry. The refusal leaves retained bytes and the exact native conversation intact. This Codex-specific limitation protects the OpenKit control channel and is removed when Codex provides whole-entry replacement. Independently authored entries remain available under native configuration.

Before native work, the adapter must prove that the selected native configuration preserves those external-authority and credential boundaries. An unrepresentable, invalid, or unverifiable configuration fails closed while preserving its bytes; there is no generated-over-existing repair or fallback to another home or conversation. Resumed open still proves the exact retained reference without contacting the capability loopback. The first bound Turn applies current external MCP supply, and incompatible later supply changes still require the authorized successor boundary. Native data and configuration grant no live continuation or replay authority.

Qualification must cover startup with no base config, byte-preserving authored configuration, attempted retained overrides of model/provider/Gateway/credential bindings, retained auth-store behavior, zero capability contact during resumed open, local in-Sandbox MCP use without an external bypass, and exact native resume after the old control root is removed. Credential absence must be checked across the complete retained home, including native databases, WAL files, and logs, for the qualified configuration and logging posture.

The engineer accepted this amendment in [Codex Retains Its Whole Native Home Under Fixed External Authority](../decisions/20260930-codex_home_retained_whole.md).

## Session Operations

The Harness owns lifecycle sequencing. The adapter owns native thread identity, event translation, and Codex configuration.

- `session.open` starts one supervised App Server for this binding; native thread creation is deferred to the first bound Turn, and a new binding reports `pending` until that Turn establishes a resumable exact thread, while a resumed binding proves that thread before `ready`.
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

## Reasoning Effort Delivery

For every Turn with recorded effort in its immutable AEP on a route carrying `reasoningEffortLevels`, the adapter supplies that value through App Server v2 `turn/start.effort` on the exact retained native thread before the prompt is admitted. It uses the [canonical OpenKit enum](../core/protocol.md#canonical-enums); native names for these values are unchanged. On reasoning routes, explicit `none` is the string value, never omission or null. The runtime's broader native vocabulary does not expand OpenKit's closed enum.

Shared delivery, omission and retention, Turn authority, effective-level diagnostics, failure and lifecycle semantics, and acceptance are owned by [AEP delivery and retention](20260616-agent_environment_package.md#reasoning-effort-projection-and-delivery); on routes without `reasoningEffortLevels`, its exception requires no native effort and a bounded diagnostic without failing the Turn or changing the conversation's current selection.

On reasoning routes, Codex-specific acceptance proves that App Server v2 `turn/start.effort` supplies the recorded value on the exact retained native thread before the prompt is admitted, and that supported canonical values, including explicit `none`, reach Gateway unchanged.

## Native Output Mapping

The final assistant response is the correlated App Server terminal result, not a `--output-last-message` file. The adapter validates that result, applies the shared 16 MiB bound, decodes UTF-8, trims surrounding whitespace, and returns either one assistant message or no message together with the exact native-handle proof.

App Server events are not imported directly into NanoCore product state. When runtime provenance is enabled, the evidence projection is owned by the provenance specification. The accepted design replaces exec JSONL stdout capture. The retention boundary in Provenance stays here.

Outside the separately bounded streaming provenance path, native result content is limited to 16 MiB. The shared process runner retains at most a 16 KiB prefix from each of stdout and stderr for failure diagnostics before redaction.

Malformed native events may invalidate provenance evidence, but they must not bypass candidate terminal classification or cause NanoCore to accept native Codex schemas.

The adapter returns normalized assistant content or a product-safe failure classification. The shared Harness emits schema-conformant candidate records, and NanoCore alone validates and commits canonical Items and terminal state. Live native token streaming into product Items is not supported.

## Control Mapping

The target OpenKit worker envelope is one open Codex AgentSession with zero or more sequential Turns and at most one active Turn in that AgentSession. The Turns are not per-Turn `codex exec` processes.

- `session.open` creates the private state root and starts the supervised server; new-thread establishment occurs on the first bound Turn, while resume proves the exact retained thread at open.
- `turn.start` submits the Turn on that resident thread.
- `turn.interrupt` reports the actual cancellation outcome for that AgentSession's work and does not close the session.
- `session.inspect` and `session.close` use the fixed adapter operations above.
- Native approval requests, questions, steering, and follow-up remain unsupported.

Another resident AgentSession belongs to another Thread and has a distinct private `CODEX_HOME`, native handle, server process until sharing is proved, Turn slots, the two loopback credentials, and cleanup proof even when it selects the same Agent, image, model, or provider. The adapter never selects an AgentSession by `--last`, title, cwd, sibling state, or ambient Codex home.

## Skills And MCP

NanoCore resolves approved static Skill and selected MCP supply into the AEP. The Codex adapter projects exactly the resolved MCP server ids through the fixed authenticated loopback URLs above. NanoCore still owns catalog resolution, authorization, credentials, transport, usage, and audit, and the adapter must not discover, install, connect directly, authorize, or broaden supply. An empty manifest MCP selection does not disable the capability plane: resolved supply still includes the built-in servers supplied by [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md). A missing capability loopback credential fails `session.open` before native work. A reload or re-list, when the probed declaration says the client lists tools again, happens at a Turn boundary, not mid-Turn.

## Provider And Credentials

The authored AgentManifest owns provider, model, credential, backend-capability, and network requirements. The resolved AEP owns the preferred logical model, exact allowed route set, credential bindings, and effective launch policy. NanoCore performs that resolution but does not own a second native-runtime configuration.

The shared shim requires one unique AEP route for the preferred model and passes that preferred route and the exact admitted route set to the adapter, while native route projection remains adapter-specific. Neither NanoCore nor the shared Harness infers Codex provider configuration or falls back to another model. The adapter rejects any selected route whose exact endpoint, credential binding, model, or wire protocol the selected App Server cannot represent.

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
- Distinct-Thread AgentSession-private `CODEX_HOME` roots, rejection of two current bindings for one Thread, preserved admitted native config and rules with proved external-authority isolation, and ignored configuration outside the admitted Sandbox roots, exact thread establishment, exact resume by a later server, sibling rejection, and close preserving `CODEX_HOME` while removing only the ephemeral control binding, image defaults in a fresh home, and a local Skill that remains available when the selected Skill set is empty
- Rejection of `--last`, title, cwd, ambient-home, missing-handle, conflicting-handle, and unsupported interactive capability paths
- The 16 MiB native-result bound and the 16 KiB redacted diagnostic prefix per stream
- Unknown-model descriptor behavior only for the branch the selected binary still requires, including no caller-supplied catalog and no descriptor in retained `CODEX_HOME`
- Two Turns on one thread against a synthetic Responses provider and a new server resuming that thread; if shared hosting is enabled, unsubscribe one binding while a sibling thread runs and prove the sibling is unaffected
- The native process never holds the upstream token. Idle refusal, sibling refusal, and the Turn-barrier drain are consumed from [Worker Agent Capability](20260703-worker_agent_capability.md). Release does not affect a sibling once sharing is in the test. A terminal Turn result is not proof that background tools stopped
- Inspection distinguishes the surviving server and thread from a replacement or an unknown identity, launches no work on a mismatched identity, and `harness.drain` refuses new `session.open` and `turn.start` while admitted work and cleanup settle
- A supply change between two Turns either shows the new supply on the second Turn or follows the probed setup-change successor. The check reads the model-visible schema
- Full native permission at launch; unexpected permission requests receive the shortest-lived allow by default without Turn interruption, while the deny-capable response path and authored native deny rules remain available
- Authored plugins and retained-home hooks observably act during a Turn, and model-directed shell commands and workspace file writes execute with observable effects
- Protected HTTP MCP id collisions, including disabled entries, retain managed URL and credential precedence, complete the Turn, preserve authored bytes, and return a credential-free warning naming the id on adapter result diagnostics
- Protected non-HTTP MCP id collisions, enabled or disabled, refuse preparation before native work, preserve configuration and exact conversation bytes, and carry a warning naming the id and a rename instruction on the existing error envelope; renaming the authored entry permits a subsequent Turn
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
- Web and the remote MCP show the same running, reconnecting, closed, and resume-failed outcomes.
- Where a load operation exists, it does not restore a pending RPC. There is no transparent recovery of in-flight work.
- Workspace collection does not claim stability while a relevant writer remains active. This adapter does not treat process exit as the collection gate. Collection is owned by [Workspace Synchronization](20260703-workspace_synchronization.md).

## Implementation Evidence And Limit

The [2026-10-05 runtime upgrade decision](../decisions/20261005-worker_runtimes_upgrade_to_latest.md) selects npm latest `0.160.0`. Regeneration by that installed vendor binary yields the same 314 JSON schemas as `0.159.2`; the consumed App Server protocol, configuration destinations, and rollout shape are unchanged. Native SQLite initialization, telemetry reclamation, and plugin caching changes remain upstream implementation details; the adapter requires no protocol compatibility path. Prior-pin observations below retain their original version attribution.

The resident App Server v2 adapter is pinned to the installed npm distribution `@openai/codex@0.160.0`; its generated schemas are the consumed discriminant source. Production selects `/usr/local/lib/codex/bin/codex`, while tests resolve the installed vendor package for the executing supported platform and inject its binary through the process runner. Image installation, schema-package inclusion, and deployed smoke remain with the image slice. This implementation is not fully qualified: a native drain/persistence flush boundary and external-authority isolation inside the deployed Sandbox remain unproved.

New open performs the handshake and reports `pending`; the first bound Turn establishes the native thread with its own working directory, model, and MCP supply. A non-empty rollout at the returned native path is the resumability probe. Inspection has a one-second filesystem deadline and rechecks the same live, usable binding after that await. Exact resume proves the retained id without contacting the capability loopback. The first successor Turn applies its supply once through unsubscribe/resume; subsequent MCP or working-directory changes are refused before any native request. Codex does not re-list tools at Turn start, so supply change requires a successor. The real-pin test removes the old control root, opens a new control root with rotated credentials, and observes prior user/assistant context and gamma tools, with no idle capability contact. The exact admitted route set and descriptors are fixed and compared without route order; unsupported preferred routes and changed sets fail before native Turn requests while preserving the binding. Preferred logical-model selection uses the pinned per-Turn `turn/start.model` mechanism, verified in the synthetic provider request. Skill roots project the complete current set on every Turn, including the empty set. Real model and blocked-tool interruption settle as interrupted, keep the binding running, and permit a later Turn.

Loss of stdout, malformed consumed evidence, unknown item/status values, contradictory or duplicate terminals, and unqualified native error semantics poison the binding monotonically. A confirmed dedicated-host stop permits a failed result; an unproved stop rejects settlement for Harness interruption and fencing. Subsequent frames cannot revive success, and a terminal outside the pending/active correlation fences the binding. RPC errors require stop confirmation; neither arbitrary error codes nor a native extension field certify non-acceptance. Request/result alternatives and individual items are validated. RPC/send control waits are four seconds, aggregate open/setup is five seconds, inspection is one second, and interrupt RPC plus terminal proof is four seconds; cleanup adds at most two two-second stop intervals, keeping each control path below the ten-second Harness budget. Ordinary model execution has no control deadline. Timers, pending requests, backpressure listeners, and bounded-stop exit listeners are released on terminal paths. Closing fences admission before and across awaited setup.

Close memoizes its complete promise, including rejection, and always attempts bounded host cleanup. The pin's generated `thread/unsubscribe` response and `thread/closed` notification expose no qualified persistence-flush or writer-absence predicate. Loaded-conversation close therefore rejects with that concrete limitation even after confirmed host exit; forced SIGKILL is not reported as successful drain. A repeated close cannot convert earlier failure into success. Successful loaded-conversation close remains an open qualification requirement.

Inference and MCP credentials use the in-memory provider and HTTP-header overlays established in prior real-pin tests; they are absent from argv, environment, generated config, retained rollout evidence, and returned diagnostics. Command/file approvals and MCP elicitation use the pin's one-request acceptance response by default. Additional permissions are granted only for the current Turn. User-input requests have no supported automatic answer and fail the binding rather than inventing user input. Unknown requests likewise fail closed. Permission records have fixed labels, a sixteen-record bound, and reset at Turn start. Stdout and stderr use streaming UTF-8 decoders with final flush; diagnostics redact before taking a valid UTF-8 prefix of at most 16 KiB, including redaction expansion.

The complete stable Thread-private `CODEX_HOME` is now `stateRoot`; the adapter generates no base configuration, sessions symlink, native database relocation, filename inventory, or disposable native home. Launch controls prevent native updates and web search and select an ephemeral auth store; native local features otherwise follow authored configuration and pin defaults, while the external provider and current Gateway credentials stay in native in-memory overlays. Real-pin tests preserve authored configuration and auth-store bytes, override retained model/provider/endpoint/credential preferences, exercise a local stdio MCP tool without injected credentials, and resume the exact native thread after removal of the old control root. Effective native configuration is read before loading a thread; retained Gateway MCP entries are disabled in memory until explicitly selected by current AEP supply, preventing capability contact during resumed open. Whole-home byte scans run during live work and after both hosts stop, covering native SQLite, WAL, and log files as well as rollouts. The deployment's Sandbox network envelope and arbitrary native configuration/logging remain qualification limits; these host probes do not authorize external bypass or certify that broader boundary. Qualification stops at that deployment boundary rather than weakening Gateway admission, filtering retained filenames, or rewriting native database rows.

The current pin recursively merges session MCP overlays into authored entries. HTTP collisions retain the managed URL and credential header, with a warning on the existing adapter result diagnostics even when the Turn completes. Only authored non-HTTP entries are refused before configuring or prompting the native thread, with a rename instruction and warning on the existing worker error envelope. This enabled-state-independent non-HTTP limitation is removed when native whole-entry replacement becomes available. The shared Harness currently does not propagate adapter preparation-error diagnostics to its control refusal, and the Turn consumer does not forward completed-result diagnostics; those consumer gaps remain outside this adapter's scope.

Opt-in App Server provenance remains refused before native Turn work because the historical exec provenance parser is not an App Server primary-stream collector. Ordinary rollout observations remain separate. Round-four regressions and guard mutations cover channel loss, poisoned publication, terminal duplication/contradiction, inspection/exit races, native error alternatives, bounded writes/interrupts, close failure retention, Unicode diagnostics, and deterministic production-path selection. The worktree report records exact execution output and remaining limits; passing package checks do not complete native-home authority qualification, drain/flush, deployment, or cross-layer product workflows.

A direct probe of the installed pin reports `/etc/codex/config.toml` as its native system configuration layer below user configuration and session flags. The existing adapter invocation leaves that layer enabled; image authors use that native path without copying defaults into each retained home. No process-level system-source redirect was found in the installed package documentation, CLI help or binary strings; probes of candidate Codex and XDG environment variables leave the system source unchanged. Authored `/etc/codex` defaults must be qualified in the image smoke: application on a Turn, protected model/MCP/fixed-control precedence, retained-home preference precedence, and invalid or unreadable system-source behavior remain unproved by this host slice, which does not write `/etc`. The pin exposes administrator requirements, including allowed approval policies and sandbox modes, and names `/etc/codex/requirements.toml` and legacy `/etc/codex/managed_config.toml`; `configRequirements/read` reports no loaded requirements here, even with conflicting files beside the temporary private home and candidate redirected source. Rejection timing for an actually loaded administrator conflict remains an image-smoke qualification limit; no speculative guard or fresh-home initializer was added. Real-pin synthetic-loopback Turns show native `CODEX_HOME/skills/` descriptions alongside managed `skills/extraRoots/set` supply and in a fresh conversation with empty managed supply; native discovery retains the local Skill after the managed roots are cleared, and its authored bytes stay unchanged.

At the prior `0.159.2` pin, the Codex-specific shared protected-name projection covers `CODEX_HOME`, `CODEX_SQLITE_HOME` and `CODEX_ROLLOUT_TRACE_ROOT`. The native App Server reads these retained-state destinations; probes establish relocated SQLite files and rollout-trace bundles, while the accepted owner explicitly owns the fixed retained home. The adapter launch check uses that Codex-specific projection; shared bootstrap values such as `HOME` and `TMPDIR` arrive from the trusted Harness. `CODEX_ARGS`, `CODEX_BIN` and `CODEX_EXECUTABLE` are not native selectors in this pin, and `OPENAI_LOG` is not a native auth or inference binding. Built-in provider preferences are superseded by the explicit Gateway provider and credential overlays; the App Server session uses local execution, independent of the CLI executor environment selector. A vendor prefix alone is not protected. The loopback-credential value check remains separate.

The Reasoning Effort Delivery contract above is implemented and covered by pinned-runtime synthetic inference regressions. The adapter supplies the recorded canonical value through `turn/start.effort` on the retained thread for a reasoning route, including explicit `none`, and omits the control when effort is absent or the route has no reasoning, recording the existing bounded no-reasoning diagnostic. Codex 0.159.2 was observed to retain the previous effort in its HTTP body when a Turn on a route without reasoning omits `turn/start.effort`; this native observation does not establish Gateway suppression, which remains awaiting implementation.

## Acceptance

This adapter is clean only when deleting it removes all Codex-native protocol, output, and provenance knowledge without changing the shared worker contract or NanoCore product and governance core. The deployment image is shared and is not deleted with the adapter.

## Related Documents

- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
- `docs/specs/20260721-worker_execution_environment_images.md`
- `docs/specs/20260930-deepseek_worker_adapter.md`
