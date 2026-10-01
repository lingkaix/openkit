---
status: Accepted
implementation: Partial
kind: boundary
updated: 2026-10-01
---
# OpenCode Worker Adapter

## Generic Volume Retention Amendment

[Persistent Worker Volumes](20260910-persistent_worker_volumes.md) owns complete opaque data/home volumes and supersedes this adapter's deletion of native data at ordinary Turn or AgentSession close. The adapter locates its data directory in its admitted stable Thread-private home and leaves all contents intact, without a list of known filenames. Generated launch and control material remains in separate ephemeral roots. Opening or closing a native binding must not recursively erase the retained data directory. Closing still invalidates the exact binding and proves writer absence. Retained native histories, memory, configuration, and unknown files do not select a conversation, grant OpenKit credentials, or grant external model, tool, provider, or network authority; admitted native configuration follows Native Local Configuration below.

OpenCode V2 server operations, event translation, and feature restrictions remain owned here. Whole-volume retention alone does not discover a session or grant credentials or external authority. Exact resume uses the retained reference under [AgentSession](../core/agent-session.md). A resume that is not the exact session fails explicitly and never falls back to a fresh conversation, an empty conversation, or a transcript replay. This version starts from a new data root and does not read earlier-version native state ([earlier-version data is not carried](../decisions/20260930-earlier_version_data_not_carried.md)).

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

The runtime starts with full permission inside the Sandbox ([Sandbox full-capability rulings](../decisions/20261001-sandbox_full_capability_rulings.md)). A residual native permission ask receives the shortest-lived native allow by default and does not interrupt the Turn. Existing programmatic decision points retain their refusal capability for future user-configurable policy; no such policy configuration is introduced here. User-authored explicit deny rules remain effective. Forms are answered only when the pin exposes an unambiguous allow-equivalent decision; forms requiring authored answers are cancelled without inventing answers, and unproved native drain retains the existing stop/fence obligation.

The V2 native server is required. It must not be exposed as NanoCore routes, and it must not imitate an OpenKit gateway.

## AEP Inputs Consumed

The shared Harness supplies the adapter with:

- adapter id `opencode`
- turn input
- worker working directory
- the admitted Thread-private retained home and separate ephemeral control slots
- the provider, model, endpoint, and credential bindings from the Turn's unique preferred LLM route and the binding's exact admitted logical-model route set
- the exact server ids from resolved AEP MCP supply, including automatically supplied built-in servers
- the two session-local loopback credentials, and no worker-control credential

The Harness passes the Turn's unique preferred route and the binding's exact admitted logical-model route set. The adapter configures the whole set, selects this Turn's preferred route, and never invents a model or provider fallback. The adapter does not resolve providers, credentials, models, permissions, or workspace policy on its own.

Server configuration combines OpenCode's native configuration from the admitted home and workspace with the adapter's protected overlay under Native Local Configuration. `OPENCODE_AUTH_CONTENT={}` must not be replaced by a stored provider credential. Sharing, automatic updates, model-catalog fetches, default plugin installation and LSP downloads stay disabled, because they publish or download outside the Sandbox without an admitted grant. The V1 environment-variable spellings are not the contract; the requirement is that outcome. Native data under the retained home is persistent and is the resume store for sessions this version created.

Because the pinned V1 client loaded managed configuration after inline configuration and offered no disabling flag, `/etc/opencode` must not be able to override the adapter's explicit configuration. The V2 equivalent preserves that outcome. Until a probe shows a private configuration that cannot be overridden from that path, the image proves `/etc/opencode` is absent.

## Native Local Configuration

OpenCode's native configuration, instructions, Skills, plugins and local MCP configuration load from the admitted home and workspace with native precedence. Image defaults reach the home by native layering where the pin supports it, otherwise by initializing a fresh home, under [Persistent Worker Volumes](20260910-persistent_worker_volumes.md#native-defaults-and-private-home-placement). A private launch home must not make them unreachable. The adapter overlays only the bindings it owns: the model and Gateway route, the exact OpenKit-managed MCP projection, the capability credentials, the exact session, the required host plugin and control bindings. A native entry colliding with a protected binding is replaced as a whole by the final OpenKit layer without editing the user's files. The adapter reports a bounded credential-free warning through its existing diagnostics channel ([Sandbox full-capability rulings](../decisions/20261001-sandbox_full_capability_rulings.md)). Plugin code that changes a protected binding while it runs is outside supported supply, with no comprehensive prevention or closed-outcome guarantee ([OpenCode Plugin Support Boundary](../decisions/20261001-opencode_plugin_support_boundary.md)).

## Session Operations

`session.open` starts the server with explicit configuration and establishes or resumes the exact native session before work. The adapter inspects native automatic recovery before startup admission so unknown effectful work is not resumed outside authorization. `turn.start` reuses that session. Abort stops the Turn's work and leaves the session present. `turn.interrupt` reports the actual abort and does not close the session. `session.close` stops the binding's work, preserves native data, and does not delete the session as its method of release. A successor resumes the exact session. `session.inspect` reads the exact surviving host and native conversation, launches no work, and fails closed on an unknown or mismatched identity. `harness.drain` is the Harness admission fence. While admitted work and cleanup settle, this adapter refuses new `session.open` and `turn.start`. The Harness owns that fence. This adapter does not invent a native drain RPC.

The six operations are owned by [Worker Control Protocol](20260703-worker_control_protocol.md#harness-control-operations). This section maps each of them onto the open, inspection, prompt, interrupt, close, and admission-fence behavior above.

`session.open` carries `resume: { locator, digest } | null`. The raw reference stays in retained Sandbox storage outside the ephemeral control slots. Core stores the locator and the digest. Initial hosting is one server per binding until capability isolation for a shared server is proved. Closing a shared-host binding, once sharing exists, does not kill the server. A host restart invalidates every binding on that server. A transport loss and a NanoCore restart may each adopt the exact surviving binding, including its lineage, sequence, and lease, under the existing continuity and NanoHost proof contracts, with no duplicate effect. A binding that cannot be proved exactly is closed or fenced, and a successor resumes the native conversation. A NanoCore restart does not by itself end the binding. The server's own exit still ends the bindings that process hosted.

The live event stream is not a replayable transcript. A prompt response or an idle event is not proof that tool descendants stopped writing. Event subscription may be used inside the adapter and must not become a NanoCore API.

No environment variable, AEP extension, test option, or image diagnostic may replace the adapter-produced client operations. Tests inject a runner or a static test adapter without creating a production command override. NanoCore never constructs an OpenCode command. There is no shell-built command.

## Reasoning Effort Delivery

For every Turn with recorded effort in its immutable AEP on a route carrying `reasoningEffortLevels`, the adapter uses V2 `session.switchModel` to select the admitted logical model and its declared effort variant on the exact retained session before the prompt is admitted. On reasoning routes, native model metadata declares one variant for each of the seven [canonical OpenKit effort levels](../core/protocol.md#canonical-enums), carrying that level's exact Gateway wire value. Automatic native variants are not assumed to cover the admitted set. Selection must be applied and verified before prompting. On reasoning routes, explicit `none` selects its declared variant, never omission, null, or a base/default variant. On a Turn without recorded effort the adapter does not reselect an unchanged admitted model, so the conversation's current variant stays in effect; a change of admitted model follows native selection and restores or reapplies no variant.

Shared delivery, omission and retention, Turn authority, effective-level diagnostics, failure and lifecycle semantics, and acceptance are owned by [AEP delivery and retention](20260616-agent_environment_package.md#reasoning-effort-projection-and-delivery); on routes without `reasoningEffortLevels`, its exception requires no native effort and a bounded diagnostic without failing the Turn or changing the conversation's current selection.

On reasoning routes, OpenCode-specific acceptance proves that V2 `session.switchModel` selects the declared effort variant, that selection is applied and verified before prompting, and that all seven canonical values, including explicit `none`, preserve their exact Gateway wire values.

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

OpenKit-managed MCP is server configuration on the dedicated server, for the exact selected supply, not a cwd-scoped ACP registry. Dedicated initial servers avoid sharing a live configuration scope across sessions. The adapter must not discover, install, connect directly to, authorize, or broaden OpenKit-managed MCP supply. Independently configured local Skills and MCP follow Native Local Configuration; the managed selection is projected separately and does not disable them. [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md) owns the Gateway plane for external systems. In-Sandbox MCP is unrestricted.

The adapter declares whether the server lists tools again at Turn start. The implementation slice establishes that declaration by probe. When it does not, a changed supply is a setup change replaced by a successor AgentSession that resumes the native conversation. Narrowing and revocation apply at the next call as `capability_denied`.

## Provider And Credentials

The authored AgentManifest owns provider, model, credential, backend-capability, and network requirements. The resolved AEP owns the preferred logical model, exact allowed route set, credential bindings, and effective launch policy. The Harness passes the Turn's unique preferred route and the binding's exact admitted logical-model route set. The adapter configures the whole set, selects this Turn's preferred route, and never invents a model or provider fallback.

For the trusted relay, the native provider id is the fixed slash-free adapter-owned id `openkit-worker-inference`. The model id is the exact admitted model id, serialized rather than interpolated. The base URL is `http://127.0.0.1:17892/inference/v1`. The AEP provider instance id remains NanoCore evidence and is not the native provider id. Configuration contains no credential value. The inference bearer is the session loopback credential, not `OPENKIT_WORKER_INFERENCE_TOKEN`. A request hook is the researched candidate for applying the current Turn's authority on each model request, including retry and compaction. It is not a proved mechanism, so this specification states the credential rule and does not treat the hook as qualified. If the probe fails, the credential rule still stands and the hook is not replaced by putting the upstream token in the environment.

Direct-provider routes are unsupported. Direct and otherwise unsupported routes fail closed before the session admits work, rather than receiving a fallback.

Mint, attribution, the Turn-barrier drain, and destruction of the two session loopback credentials belong to [Worker Agent Capability](20260703-worker_agent_capability.md). The adapter consumes the two supplied loopback bearers and never passes upstream or worker-control tokens to the native runtime. Native credential configuration stays isolated from configuration text, diagnostics, and evidence. An unsupported route fails closed. The native carrier for each bearer is qualified by probe and is not named here. Idle refusal, sibling refusal, and Turn-barrier behavior are consumed from that contract.

Declared runtime-env credentials are session-static. A changed declaration or value yields a successor AgentSession at the next Turn. A revocation interrupts and closes the binding at once.

## Manifest And Image Contract

The repository-owned OpenCode AgentManifest selects adapter id `opencode`, the deployment image `worker-runtimes`, native executable paths used by network policy, provider and credential requirements, and only capabilities proved by this specification. [Worker Execution Environment Images](20260721-worker_execution_environment_images.md) owns the image. This version starts from a new data root and does not read earlier-version data ([earlier-version data is not carried](../decisions/20260930-earlier_version_data_not_carried.md)).

The OpenCode install slice of that image installs the selected OpenCode V2 server, sets the generic shim as the image entrypoint, and runs as a non-root worker user. The image also contains Codex, Pi, and DeepSeek. Smoke verifies the selected native version, `/etc/opencode` absent or the proved equivalent, the shim, protected-binding isolation, and non-root identity. It does not verify JSON run mode. Image contents confer no adapter authority.

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
- Admitted home and project configuration, local Skills and plugins affect actual execution without their files being overwritten. Protected-id collisions leave authored bytes intact, emit a warning, and use the admitted managed route and bearer. A later plugin hook that rewrites a provider request is outside that guarantee. Sharing, updates, model fetches, default plugin installation and LSP download stay disabled; a fresh home receives image defaults; and retained home bytes are preserved at close
- A server started with explicit configuration, the required plugin loaded alongside native plugins, a native declaration that disables the host plugin shadowed by the final OpenKit layer, a session aborted mid-tool, and the session still present afterward. A later hook that runs after the loaded plugin is outside the displacement check
- Dedicated-server MCP grants do not leak across sessions. The live event stream is not treated as a transcript
- A supply change between two Turns either shows the new supply on the second Turn or follows the probed setup-change successor. The check reads the model-visible schema
- Full launch permission, residual asks allowed once through both native response paths, user-authored explicit deny rules preserved, and observable model-directed workspace shell and file-write effects
- `/etc/opencode` cannot override explicit configuration
- No production command override
- Inspection of the exact surviving host and native conversation, rejection of an unknown or mismatched identity with no work launched, and `harness.drain` refusing new `session.open` and `turn.start` while admitted work and cleanup settle

The shared qualification cases in [Codex Worker Adapter](20260716-codex_worker_adapter.md#tests) apply to this runtime on the V2 server and `@opencode/client`. `opencode run` and ACP mode are not alternate passing interfaces.

Required image smoke covers the selected OpenCode version, the generic shim entrypoint, non-root user, and absence of `/etc/opencode` or the proved equivalent.

## Implementation Evidence And Limit

The removed OpenCode `1.18.1` run adapter is historical evidence only. The resident adapter pins `@opencode/cli@2.0.20` and `@opencode/client@2.0.20`. The darwin-arm64 package binary is `bin/opencode.exe`, a 179948336-byte Bun standalone. Tests resolve the installed package and use synthetic loopback services. No pin or dependency changes were made in round five.

Generated configuration, the final managed Skill source, the explicit host plugin, and bearer carriers live under the ephemeral private control root. Native configuration stays in retained `stateRoot/config`, home `.agents` and `.claude` discovery uses retained `stateRoot/home`, and native XDG data stays under the retained state root. The pin's own loader reads home configuration, Workspace ancestry, native instructions, Skills, plugins and local MCP with native precedence. A genuinely absent configuration home is initialized once from the shim image user's `HOME/.config/opencode`, outside the retained root; absence is valid, while unreadable entries, escaping links, an escaping destination and leftover staging fail before launch. Existing homes are reused without reading or merging image defaults. The adapter supplies the exact admitted available model catalog and retains the model/Gateway route through its final protected overlay. It supplies selected Skills through a separate final native source and selected MCP through native session-local operations. Native parsed configuration supplies credential-free collision warnings; the final managed layer replaces protected provider and MCP entries before prompt work. The tested `-openkit-loopback` declaration does not displace the host plugin: the final inline host declaration restores it, and the actual request retains the managed bearer. No static plugin-displacement path was established on this pin; this is not runtime hook inspection. The host plugin lends the capability bearer only to an adapter-created id whose draft URL exactly matches the admitted loopback URL. Independently configured native MCP drafts receive no OpenKit credential. Runtime plugin code that changes protected bindings is outside supported supply under the linked plugin support boundary; no runtime redirect regression pins that behavior. `/etc/opencode` absence remains an image smoke obligation; a binary literal search is supporting evidence only.

`OPENCODE_LISTS_TOOLS_AT_TURN_START` is false. The first Turn's working directory, selected Skill targets and MCP ids are applied once. Native MCP operations address that directory, await the supported plugin Tool transform's location-specific generation, and drain the native move operation before prompt admission. Later supply changes are refused before native requests. A successor resumes the exact `v1:` reference; its model-visible request contains the new MCP tool and prior context, and idle resume inspection makes no capability request.

New handles stay pending until a read-only `session_v2` select proves the exact row in retained `xdg/opencode/opencode.db`. Every ready inspection additionally validates live native identity, time, and closed outcome values before and after the RPC. SIGKILL/new-process regressions prove exact native resume and prior context. Unknown additive members are tolerated; unknown authority-bearing values fail closed.

Collection validates each pagination cursor as a non-null, non-array object, preserves absent/null `next` and unknown additive members, and refuses unknown `next` cores. Collected native message ids must be unique across the complete bounded page collection before pre-prompt publication comparison or settlement prior-id filtering. Same-id late-final, prior-row settlement, and cross-page prior-id regressions establish those duplicate predicates. Settlement additionally validates the admitted user id, ordered assistant evidence, exactly one idle terminal boundary, and agreement with the session outcome. Missing, duplicate, conflicting, or malformed proof stops the dedicated runtime; failure is resolved only after confirmed stop, otherwise settlement rejects. A private in-memory boundary detects new, changed, or missing prior terminal evidence before the next prompt, and collection uniqueness refuses repeated prior identities before that comparison. Both paths fence the binding. It is neither a canonical transcript nor a durable history owner. A prompt whose admission may already have occurred is surfaced as an accepted failed settlement after proved stop instead of being erased by a clean refusal.

Interruption validates the native boolean acknowledgement and derives status from correlated native terminals. Completed and failed outcomes survive cancellation races. A settled Turn cannot cancel a newer Turn, and an in-flight session cancellation holds Turn ownership until drained. Interruption reserves five seconds for RPC/terminal proof and four seconds for signal escalation inside the Harness ten-second stop budget; unproved stop rejects within that bound. Normal inference has no adapter-imposed eight-second completion timeout. Named RPC waits remain eight seconds, with shorter test-only proof bounds, and all deadline timers are cleared.

The pin's supported `serve --stdio` EOF path returns normally through scoped finalizers, including SQLite close. Idle close requests EOF and succeeds only after that normal zero-code exit and pipe drainage; forced signals, prior unexpected death, active close, and missing drain proof retain one shared rejected close promise. Pre-prompt setup failure uses that same graceful close path before returning a clean typed dependency refusal, retaining its successful close promise for later binding release. A real native empty-catalog regression through the Harness proves no prompt, clean absence, successful later close, released Thread and capacity, and an exact successor reference; unproved stop retains the active fence, and forced exit cannot supply missing flush proof or release the binding. Cleanup failure stays exceptional, while a possibly accepted prompt stays an accepted failed settlement. Real graceful close followed by exact successor resume preserves prior context. Pipe close alone is not a persistence-flush acknowledgement. Exit and stream completion are separate: each UTF-8 decoder flushes on its own stream end, including incomplete-sequence replacement, and diagnostics retain their bounded post-close wait.

Result collection bounds UTF-8 content bytes across parts and pages before concatenation, independently bounds envelope values, and checks the selected assistant text at 16 MiB. Multibyte provider output, aggregate text/reasoning, and exact-limit controls are covered. Native-derived diagnostics are redacted and bounded to 16 KiB. Unexpected native permission asks receive allow-once by default through the supported evaluate hook or session-scoped reply path. The pin exposes typed-answer forms rather than an allow-equivalent decision, so those forms remain cancelled. Unproved refusal drain still stops the host. The pin has no narrower download-disable setting for LSP, so language-server support remains disabled while the file watcher remains available.

Round-five results and guard mutations are recorded in `temp/comm-redesign/reports/build-w4-r5.md`; builder execution is not independent acceptance. The fixed Harness, Turn consumer, registry contract, dependency manifest, lockfile, and workspace configuration were not changed in this round. Round six consumes N4b's exact admitted route set. Startup creates an exact durable conversation without choosing a model; the first admitted Turn writes the exact admitted available model catalog into ephemeral configuration and invokes the pin's supported `location.reload` in the same host. The native move initializes location services before the native available catalog is proved. Every prompt follows supported `session.switchModel`, move/selection drain, and `session.get` verification. Native configuration preserves exact model ids, context/output limits, input modalities, and reasoning output. Unsupported non-preferred members, preferred non-members, duplicate native ids, and changed sets are refused before native requests. Real add/remove successor runs both preserve the exact handle and prior context, including removal of the predecessor's selected model. No placeholder model or HTTP request-body rewrite remains. Round-six checks and mutation evidence live in `temp/comm-redesign/reports/build-w4-r6.md`.

Image smoke and exact-product Sandbox qualification remain with their existing owners. The image must install glibc Linux arm64/x64 CLI builds and the client on the shim Node resolution path, keep `/etc/opencode` absent, and prove non-root execution. The client remains a devDependency because its Effect graph must not enter worker-common. Real-provider behavior, NanoCore restart adoption, Integration idle/sibling refusal, compaction recovery, and complete descendant-writer containment are not established by these adapter tests. Whole-volume bytes remain untouched; local readiness and graceful-close evidence do not replace those broader proofs.

Native Local Configuration and fresh-home initialization are implemented and qualified with the pinned runtime and synthetic loopback providers in `opencode-native.test.ts`. Authored home and Workspace resources remain effective beside non-empty and empty managed projections, and exact successor resume reuses the retained configuration without reseeding. These host checks do not establish image smoke or exact-product Sandbox qualification.

The Reasoning Effort Delivery contract above is an accepted target awaiting implementation. The current adapter does not deliver the recorded per-Turn override through a declared model variant. The current implementation reselects the model before every prompt without a variant; the absent-effort Turn rule above also awaits implementation.

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
