---
status: Accepted
implementation: Partial
kind: boundary
updated: 2026-10-01
---
# Pi Worker Adapter

## Generic Volume Retention Amendment

[Persistent Worker Volumes](20260910-persistent_worker_volumes.md) owns complete opaque data/home volumes and supersedes this adapter's deletion of native data at ordinary Turn or AgentSession close. The adapter preserves its admitted stable Thread-private data directory intact, without a list of known filenames. Generated launch and control material remains in separate ephemeral roots. Opening or closing a native binding must not recursively erase the retained data directory. Closing invalidates the exact binding and restricted handle, proves writer absence, and preserves the exact Pi session file with every other retained byte. Retained native histories, memory, configuration, and unknown files do not select a conversation, grant OpenKit credentials, or grant external model, tool, provider, or network authority; admitted native configuration follows Native Local Configuration below.

Official SDK operations, event translation, and feature restrictions remain owned here. Whole-volume retention alone does not discover a session or grant credentials or external authority. A successor resumes the exact retained session under [AgentSession](../core/agent-session.md). Resume is by that exact retained reference only. Native-session discovery and continuation by an unauthorized binding remain forbidden. An authorized successor AgentSession resumes only the exact retained reference after its predecessor is closed or fenced.

## Summary

The Pi Worker Adapter runs the official SDK inside one dedicated host process for the active AgentSession and translates that host's events into the shared OpenKit Harness result.

Plugins and Extensions run in that host, never in the Integration and Harness process. The host control channel is small and private: prompt, interrupt, evidence, configuration, and close. It is not a product protocol and it does not put Pi RPC into NanoCore. The production path is not JSON mode, not unchanged `RpcClient`, and not a Pi ACP bridge ([four native runtime adapters](../decisions/20260929-four_native_runtime_adapters.md)).

Pi's purpose in this architecture is to prove that the worker boundary is not an accidental Codex or OpenCode common denominator. Each runtime is qualified on its own.

## Owns

- Exact native-session identity, inspection, and close proof for one resident SDK host
- Final assistant extraction from SDK events
- Loading of user packages, file-based Extensions, Skills, and prompt templates through Pi's normal settings and resource loader
- Pi-specific version, event compatibility, and failure tests
- Pi-specific failure mapping and conformance evidence for manifest-declared capabilities

## Does Not Own

- Child-process supervision beyond the host process this adapter asks the shared Harness to supervise
- AEP resolution, logical-model selection, Gateway routing, credential grants, network policy, or backend lifecycle
- Canonical transcripts, product state, scheduling, review, apply, Action Center, public API behavior, or Goal Mode
- A generic RPC framework, an interactive terminal UI, or a translation of every Pi extension or UI event into OpenKit product events
- Minting of the session loopback credentials, which [Worker Agent Capability](20260703-worker_agent_capability.md) owns

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-supply.md`
- `docs/core/sandbox.md`
- `docs/core/communication.md`

## Upstream Contract

The SDK host pins `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` at exactly `0.99.1` and uses that release's native MCP. On this pin the host calls that release's configuration loader with the admitted agent directory and the session cwd, treating the admitted workspace as a trusted project, and it requires the host-supplied built-in MCP Extension when OpenKit servers are admitted. The deployment image pin remains the `worker-runtimes` version manifest. The image pin `0.85.1` at monorepo commit `d981de1229ef899957bbe968bc8dcda02a21f477`, and the published `0.87.1` commit `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`, are examined evidence of earlier pins. Main commit `4df1574339bfbd1a9750ff485bb618da397ba135` is not a pin for `0.87.1`.

The production path is the SDK host. The adapter spawns no shell and never uses `--api-key`. JSON-mode argv, including `--mode json`, `--no-approve`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, and `--offline`, is not the contract.

Pi runs with full permission inside the Sandbox under [Sandbox full-capability rulings](../decisions/20261001-sandbox_full_capability_rulings.md). Extension UI confirmation defaults to true; its existing boolean response point remains able to deny for future user-configurable policy, without introducing policy configuration now. Headless select, input, editor and custom prompts return undefined because the host cannot supply free input. UI observations remain diagnostics rather than product approval or question events. User-authored native restrictions remain the user's choice. Saved-session discovery remains forbidden, and themes and other interactive UI features remain headless.

User packages, file-based Extensions, Skills, and prompt templates load through Pi's normal settings and resource loader with an explicit agent directory, from image contents or authorized retained or mounted files. Dockerfile installation is not enough if the files land in the wrong home or only in a shell startup file. The host must not replace the resource loader with a hardcoded OpenKit tool list. An installed package is not a supported feature until its behavior is proved. UI-only panels and shortcuts report an explicit unsupported result; headless prompt answers follow the confirmation and free-input contract above. A module that loaded is not by itself a compatible feature. Browser and tool environment variables must reach the non-interactive runtime. Extensions must not read Integration control credentials or mutate another binding.

## AEP Inputs Consumed

The shared Harness supplies the adapter with:

- adapter id `pi`
- turn input
- worker working directory
- the admitted retained state root and the exact retained session reference when one exists
- the preferred and allowed logical-model contract plus the sandbox-local inference binding
- the two session-local loopback credentials, and no worker-control credential

The adapter does not choose platform Provider credentials, load resources outside the admitted roots, grant network access, or override AEP policy.

The worker-control token does not enter the host. The two loopback credentials replace upstream inference and capability tokens in the native process. The native field or SDK call that carries each credential is established by probe and is not named here. Credential refresh must not fall back to an old environment value, a stored provider credential, or another binding.

## Native Local Configuration

Pi's native settings, packages, Extensions, Skills, prompt templates, context files and local MCP configuration load from the admitted agent directory and workspace through Pi's own loader and precedence. Image defaults reach the agent directory by native layering where the pin supports it, otherwise by initializing a fresh directory, under [Persistent Worker Volumes](20260910-persistent_worker_volumes.md#native-defaults-and-private-home-placement). OpenKit applies its owned bindings last: the model and Gateway route, managed MCP projection, capability credentials, exact session and host control Extensions. Selected Skills replace native Skills with the same name. Native entries that collide with these protected bindings do not fail setup: the complete managed binding wins, user files remain untouched, and a warning enters the existing worker diagnostics envelope. Later Extension execution that rewrites protected bindings remains outside supported supply, without a detection or prevention promise. Native auth stores and credential resolvers are never a fallback for platform inference credentials.

## Session Operations

Successive Turns use one native session in one host. Pi defers native session creation and SDK open to the first Turn. `session.open` starts the resident executable and private channel, creates the explicit agent directory, and validates an exact resume reference before spawning, but sends no native open or prompt and makes no capability contact. The first bound Turn supplies the working directory, model, and MCP server ids; it opens the SDK session and creates a new conversation or resumes the exact proved conversation before prompting. Inspection before that Turn returns `pending` for a new conversation, or `ready` for the exact successor reference after repeating its retained header proof while the host is live. A failed first Turn grants no reusable authority, including when its user message was persisted. `session.open` carries `resume: { locator, digest } | null`. The raw reference stays in retained Sandbox storage outside the disposable control root. Core stores the locator and the digest. The JSONL itself remains retained data and is not, by itself, permission to resume.

The candidate path is a strict child of the admitted state root. The adapter never discovers, selects, truncates, or replaces some other retained file. The successor is handed the exact retained reference.

Missing, empty, malformed, symlinked, wrong-id, or wrong-cwd identity fails before work. A missing file is a failure, not a new conversation. The restricted handle consists only of this exact path and header identity and exposes only its digest and state through the shared Harness. An indistinguishable file with the same admitted path, header id, and cwd satisfies this proof. The adapter adds no inode or byte-history tracker.

`turn.start` prompts the resident session. The admitted logical model may change across Turns while the exact conversation continues. Collection requires that Turn's provider and model. Model and tool selection are SDK operations at a declared boundary, normally before the next Turn. Compaction can occur inside a prompt. The adapter retains Pi's native entry graph and records only compaction identities actually observed.

`turn.interrupt` reports the actual outcome and does not close the session. `session.inspect` repeats the identity proof without launching work and distinguishes this host from a replacement. An unknown or mismatched identity fails closed and launches no work. `session.close` stops work, finishes cleanup, and terminates that dedicated host, preserving the session file and every other retained byte, and proves writer absence. `harness.drain` is the Harness admission fence. While admitted work and cleanup settle, this adapter refuses new `session.open` and `turn.start`. The Harness owns that fence. This adapter does not invent a native drain RPC.

The six operations `session.open`, `session.inspect`, `turn.start`, `turn.interrupt`, `session.close`, and `harness.drain` are owned by [Worker Control Protocol](20260703-worker_control_protocol.md#harness-control-operations). This section maps them onto the open, inspection, prompt, interrupt, close, and admission-fence behavior above.

A host exit ends that AgentSession. A transport loss and a NanoCore restart may each adopt the exact surviving binding, including its lineage, sequence, and lease, under the existing continuity and NanoHost proof contracts, with no duplicate effect. A binding that cannot be proved exactly is closed or fenced, and a successor resumes only the exact retained reference. A NanoCore restart does not by itself end the binding. Failed or interrupted collection returns no new ready authority. A failure after native bytes were written fails the Turn without rolling back, truncating, deleting, or repairing the retained file. The adapter does not infer that a failed OpenKit Turn left no native effect.

No environment variable, AEP extension, test option, or image diagnostic may replace the adapter-produced native operations. Tests inject a runner or a static test adapter without creating a production command override, and NanoCore never constructs a Pi command.

## Reasoning Effort Delivery

For every Turn with recorded effort in its immutable AEP, the SDK host applies `AgentSession.setThinkingLevel` after selecting the admitted model and before `AgentSession.prompt` admits the prompt. The [canonical OpenKit enum](../core/protocol.md#canonical-enums) maps `none` to native `off`; other supported names are unchanged. The native model metadata supplies an explicit supported-level map whose wire values preserve the OpenKit values, including `off` to `none`. It does not rely on implicit availability or native clamping to express a supported level. Explicit `none` uses the native `off` selection with that map, never omission or null; the Turn selection does not write a global default.

Shared delivery, omission and retention, Turn authority, effective-level diagnostics, failure and lifecycle semantics, and acceptance are owned by [AEP delivery and retention](20260616-agent_environment_package.md#reasoning-effort-projection-and-delivery).

Pi-specific acceptance proves that the SDK host applies the selected level after admitted model selection and before the prompt, that native `off` reaches Gateway as canonical `none`, and that other supported native levels preserve their exact Gateway wire values through the declared map.

## Native Output Mapping

The adapter requires one settled, correlated successful assistant outcome for the admitted prompt. The provider and model must equal the admitted launch. It rejects an error, an abort, length exhaustion, terminal tool-use without a completed continuation, an unresolved retry, and contradictory terminal evidence. It concatenates explicit text content in order with no inserted separators, trims the combined boundary once, and requires a non-empty combined result. Settlement does not require process exit. An admission acknowledgement, an assistant or tool cycle end, or an intermediate agent end is not the completed Turn. Unknown events are ignored and cannot satisfy a lifecycle predicate. Tool and extension envelopes stay inside the adapter. They do not enter `packages/worker-protocol` or NanoCore.

Native result content is limited to 16 MiB. The shared process runner retains bounded stdout and stderr prefixes for adapter diagnostics before redaction, including protected-binding warnings on completed results. The JSON-mode event names `agent_settled`, `message_end`, `turn_end`, and `agent_end` are historical names of the removed path, not the SDK product schema.

The adapter returns a normalized final assistant message and adapter-local diagnostics. The shared Harness writes schema-conformant candidate records, and NanoCore alone validates and commits canonical product state. Live native token streaming into product Items is not supported.

## Control Mapping

- `turn.interrupt` uses the host's native cancel, reports the actual outcome, and does not close the session by itself.
- Steer and follow-up are not advertised and are not active-turn product controls.
- Extension UI confirmation defaults to true; prompts requiring free input return undefined. These observations are not a product approval or question channel.
- Pi RPC does not enter NanoCore.

## Skills, Extensions, And MCP

The host requires the workspace-patched `@earendil-works/pi-coding-agent@0.99.1`: `pnpm-workspace.yaml` applies `patches/pi-coding-agent-0.99.1-openkit-native-state.patch` to expose `McpExtensionOptions.onConnectionState`, which stock 0.99.1 does not provide. The private configuration-loader and default-transport imports resolve from that same pinned package. An image must deploy the built host with its patched production dependency closure; a plain npm installation of Pi is not equivalent.

The SDK host adds createToolSearchExtension() from the same pinned patched package alongside its existing host-supplied createMcpExtension(...); it does not add createCodemodeExtension(). On a new or exact-successor session, the host preserves the effective tool set established by the pinned SDK's current settings and native registration lifecycle, then explicitly adds tool_search through the public active-tool API before provider work. It does not replace that set with a singleton or a restrictive tools allowlist and does not overwrite authored defaultTools. The resource is builtin:tool-search when supplied as a named builtin; the model tool is tool_search. Registration alone is insufficient because that tool is inactive by default.

Activation must not overwrite authored defaultTools or discard the effective current native tool set. Use the existing post-binding setup boundary to add tool_search to session.getActiveToolNames() with the public setActiveToolsByName API and prove its genuine native registration and activation before provider work. Pi 0.99.1's createAgentSession reconstructs the initial selection from current native settings/defaults, not from retained transcript declarations; the host adds no transcript restoration, default-versus-history merge, per-Turn reset or eager rediscovery. Keep current native registration behavior, including direct managed tools, and retain the existing asynchronous managed-connection readiness gate. Do not infer that binding completion means every user MCP tool is registered. Resident search activation continues normally; a successor may rediscover a formerly active searchable tool. Comment and document this pin limitation accurately rather than asserting that native restoration already ran.

Native tool_search discovers and activates user tools with codemode, codemode-deferred and deferred MCP exposure for direct calls by their exact native registered names on subsequent model requests. It preserves user exposure configuration and never loads hidden tools. OpenKit-managed servers retain exactly exposure: 'direct', the admitted server ids, capability-local URLs and capability Authorization header; search neither re-registers those servers nor changes their transport, exposure, selection or credentials. One server has one connection owner. No community adapter, custom search proxy, configuration translator, forced direct-exposure rewrite or restrictive session tools list is introduced for this purpose.

Host-owned MCP and native tool-search remain distinct required resources. The host's versions must be in effect before provider work, including when authored settings exclude them or native Extensions supply replacements. The managed overlay replaces conflicting bindings and warns through existing diagnostics without editing authored files; MCP ownership includes its connection handlers so one server has one connection owner. Search's effective registration and model declaration must belong to the host-supplied native search implementation. A genuine factory or dependency failure remains a setup failure.

The native MCP loader examines the configuration actually returned at connection time, including entries created during Extension loading. For every admitted server id, the host replaces the whole native entry, including a disabled or stdio entry, with its managed Gateway transport and emits a warning on collision. Unmanaged entries retain native behavior. A partial merge must never leave native transport or credential fields in a managed entry. Factory load, search availability and binding completion are not connection proof: each managed server must complete native setup and tool registration on its owned transport before provider work; an empty catalog is valid. Credential redaction precedes native conversion, logging and persistence, and cancellation closes pending as well as connected transports.

Search activation uses Pi's existing native tool and transcript mechanisms, not a second persisted discovery catalog. In Pi 0.99.1, createAgentSession supplies an initial tool list from current settings or defaults on both new and resumed sessions, so that factory path does not restore the transcript's prior active declaration set. The CLI session-construction path has the same behavior; native tree navigation is a separate restoration path and is not invoked to manufacture successor continuity. The host follows this pin's construction behavior and adds native search, without deriving a startup loadout from retained history, proactively re-searching it, or rewriting saved settings. A searchable tool activated in the predecessor may therefore need native search again after exact successor resume. This is a documented pin limitation despite the upstream transcript-restoration intention; it changes neither the exact resumed conversation nor retention of its bytes.

Two Turns in the same resident host keep native search activation and one MCP owner per server without repeating startup selection. An authorized successor resumes only the exact retained conversation, reestablishes the required builtins and current managed direct projection, and adds tool_search to the current native set. A model-issued direct call to a previously searched but currently inactive tool returns the native unavailable-tool error without a target effect; the model can search and issue a new call if the tool is currently registered, searchable and permitted. The host does not replay or retry the failed call automatically. Hidden, missing or withdrawn tools and revoked managed capability remain unavailable; historical declarations do not restore authority. Required builtin or managed-connection failure still refuses setup under the existing contract. Requalify this pin-specific startup behavior on an SDK upgrade rather than preserving it through a shim or assuming a released version restored it.

OpenKit does not supply the native codemode composer, but user-configured codemode setup does not block the Turn; Pi 0.99.1 issue #10239 may send a call to a wrong but Sandbox-permitted target.

Remove the script-composition limitation only after selecting a released upstream version containing the #10239 fix, carrying the required OpenKit connection-state behavior forward, and qualifying exact-target dispatch for colliding tool and server names in both registration orders, deployed worker/assets, credential/permission behavior, cancellation and exact retained-session continuity. Issue closure, a main-branch commit, a successful arithmetic script or importable factories alone do not satisfy that condition. The selected release must also pass the ordinary result/image-content and persistence checks, including the pinned codemode image-validation defect tracked by #10215 if that result path is enabled. Record the new pin and supported script behavior in this owner and its image evidence before advertising it; do not predict a release date or delete retained data to pass the upgrade.

The search-only decision is recorded in [Pi native MCP discovery](../decisions/20260930-pi_native_mcp_discovery.md).

OpenKit-managed MCP uses Pi's native MCP with direct tool exposure, exactly the admitted server ids and Gateway capability routes, and the capability loopback credential only in the transport authorization header. Native agent-directory and project configuration loads normally, then the complete managed entries win on admitted-name collisions. The host-supplied MCP Extension must own the effective connection; one server must not have two clients. Empty catalogs are successful connections. Both loopback credentials are redacted from native MCP messages, decoded resource blobs and transport errors before conversion or persistence. Completed setup and tool registration on each owned transport prove readiness; native retry handling governs terminal connection failure. The shim does not depend on Pi packages.

The adapter must not discover, install, directly connect, authorize, or broaden OpenKit MCP supply. A locally configured Extension need not be a NanoCore catalog entry; it loads only from the admitted roots and cannot replace the host-supplied Extensions or acquire platform credentials. The adapter declares whether the runtime lists tools again at Turn start. The implementation slice establishes that declaration by probe. When it does not, a changed supply is a setup change replaced by a successor AgentSession that resumes the native conversation ([AgentSession](../core/agent-session.md)). Narrowing and revocation apply at the next call as `capability_denied`. [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md) owns the Gateway plane for external systems. In-Sandbox MCP is unrestricted.

## Provider And Credentials

The accepted runtime exposes logical worker-local inference at fixed `http://127.0.0.1:17892/inference/v1`. Pi must not receive a direct NanoCore endpoint, the worker-control token, an SSH or Gateway-forward route, or a second control path. No upstream subscription credential is passed to Pi. Platform-managed inference stays on the governed Gateway route ([four native runtime adapters](../decisions/20260929-four_native_runtime_adapters.md)).

The adapter generates the native model descriptor from current AEP authority when the admitted model or parameters change. That descriptor is the SDK input representation, not the retired generated-file mechanism and not a bounded `models.json` file. It is never read back from retained files and is not a second catalog. It contains one adapter-owned provider alias, the fixed loopback base URL, the supported protocol, and the exact admitted logical model with its effective context, output, and modality parameters. The bearer is the inference loopback credential. The descriptor must not contain the credential value, a subscription secret, an upstream Turn token, or a worker-control token. Arbitrary project files, retained native configuration, caller-provided native JSON, shell-command credential resolvers, and concrete upstream URLs are not merged into it.

Generation fails closed before the prompt when model parameters, the endpoint, or credential inputs are missing or conflicting, without a direct-provider fallback. Each new attempt regenerates the descriptor from its own admitted inputs. The historical direct `anthropic` / `claude-sonnet-4-5` path is historical evidence, not current guidance.

Mint, attribution, the Turn-barrier drain, and destruction of the two session loopback credentials belong to [Worker Agent Capability](20260703-worker_agent_capability.md). The adapter consumes the two supplied loopback bearers and never passes upstream or worker-control tokens to the native runtime. Native credential configuration stays isolated from argv, the descriptor, diagnostics, and evidence. An unsupported route fails closed. The native carrier for each bearer is qualified by probe and is not named here. Idle refusal, sibling refusal, and Turn-barrier behavior are consumed from that contract.

Declared runtime-env credentials are session-static. A changed declaration or value yields a successor AgentSession at the next Turn. A revocation interrupts and closes the binding at once. User configuration, packages, and Extensions supply no fallback platform authority.

This specification owns Pi's native representation of `modelParameters`. [Agent Environment Package](20260616-agent_environment_package.md) assigns that representation here.

## Manifest And Image Contract

The repository-owned Pi AgentManifest selects adapter id `pi`, the deployment image `worker-runtimes`, native executable paths used by network policy, the logical-model preferences for the admitted inference route, and only capabilities proved by this specification. The active route does not require a direct upstream credential binding. [Worker Execution Environment Images](20260721-worker_execution_environment_images.md) owns the image. This version starts from a new data root and does not read earlier-version data ([earlier-version data is not carried](../decisions/20260930-earlier_version_data_not_carried.md)).

The deployment image's Pi slice installs the selected Pi package and the SDK host. It does not install `pi-mcp-adapter`. It runs as a non-root worker user. Smoke proves the selected binary, the shim, non-root identity, and that the host is present. It does not prove a real inference Turn. Image-content proof is not dispatch readiness. The image also contains Codex, OpenCode V2, and DeepSeek. Image contents confer no adapter authority.

Pi-specific install commands, binary paths, event fixtures, and version pins live only in the Pi AgentManifest, this adapter, this specification, and its tests, and in the Pi install slice of the one image. They do not live in the other adapters.

Whether `/usr/local/lib/openkit/allow-anthropic-api-key` remains is not settled here. If a carrier file remains on the shared image, [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md) `credentials.declarations` stays the authority for whether `ANTHROPIC_API_KEY` is declared for the selected session, and a session whose manifest does not declare that key must not receive it.

## Failure Semantics

- Malformed or over-limit native output fails collection closed.
- Missing trustworthy final assistant content fails collection when the native run claims success.
- A non-zero or failed native outcome returns a failed adapter classification with bounded, redacted diagnostics.
- Interruption wins over partial assistant content and does not by itself close the session.
- Worker-control failure stops that binding's host through the shared Harness.
- Protected-binding collisions are warnings: the managed layer wins before provider work with user files unchanged. Later Extension execution that rewrites protected bindings is outside that setup guarantee.
- Missing, empty, malformed, symlinked, wrong-id, wrong-cwd, or otherwise mismatched admitted identity fails before work.
- Resume failure is explicit. The adapter does not create an empty session, replay the visible transcript, or pick a different file because one exists.
- The Harness preserves the admitted Pi data root. Exact resume authority is the retained reference outside the disposable control binding.

## Capability Declaration

The authored manifest is the sole launch-time capability declaration. Adapter conformance and image smoke prove that the manifest advertises only the following supported behavior. Adapter conformance does not return a second capability declaration.

- Resident SDK session and exact successor resume: supported
- Workspace edits inside declared writable roots: supported
- Normalized final assistant candidate content: supported
- Interrupt that reports the actual outcome: supported
- User Extension and Skill loading: supported
- MCP through Pi's native MCP, once per resident session, with OpenKit tools declared directly when the server offers them and with an empty catalog accepted: supported
- Live native token streaming into product Items: not supported
- Native approval or extension UI round trips: not supported
- Steer and follow-up: not supported
- Built-in Pi MCP for admitted OpenKit servers and for agent-directory user servers: supported
- Native search discovery and direct invocation of user MCP tools with default `codemode`, `codemode-deferred` and `deferred` exposure, with hidden tools excluded: supported by the search-only host contract; qualification required before claiming the route usable.
- User-configured native codemode setup: permitted under the stated targeting limitation.

## Tests

Required adapter tests cover:

- Identity preflight of the exact nonempty session header id and cwd before work, rejection of missing, empty, malformed, symlinked, wrong-id, wrong-cwd, or otherwise mismatched identity, and no inode tracker
- Close preserving the session file and every other retained byte, and rejection of any file other than the exact retained reference
- Credential-value absence, direct-route rejection, and no `--api-key`
- Changed-model continuation of the exact conversation, with that Turn's provider and model required at collection
- Unknown-event tolerance, the 16 MiB and 16 KiB bounds, one settled correlated successful outcome, rejection of error, abort, length exhaustion, terminal tool-use without a completed continuation, unresolved retry, and contradictory terminal evidence, ordered text concatenation with no inserted separators, one trim of the combined boundary, a non-empty combined result, and settlement without requiring process exit
- Inspection of the exact host and session without launching work, rejection of an unknown or mismatched identity, and `harness.drain` refusing new `session.open` and `turn.start` while admitted work and cleanup settle
- Admitted native prompts, context files and project resources reach the actual model and tool path, a fresh agent directory receives image defaults, a populated one is reused byte-for-byte, and stale auth or a native setting cannot replace the current model, Gateway, managed MCP, credential or exact-session bindings
- Two prompts in one SDK host, then a new host resuming the exact session file, with the prior context visible in the captured provider input
- SDK Extension lifecycle and authority removal: user package loading, a session-start hook, a Skill or template, one sandbox-local MCP server, OpenKit MCP exactly once through Pi's native registration, managed-overlay precedence with warnings when the loader returns an admitted name or native configuration replaces or excludes a host-supplied Extension, a successful empty catalog, redaction of both loopback credentials in native log and reflected tool-result delivery, a browser path reaching the runtime, and an explicit unsupported result for a UI-only feature. Module load is not compatibility
- A supply change between two Turns either shows the new supply on the second Turn or follows the probed setup-change successor. The check reads the model-visible schema
- Fail-closed native permissions
- A real Pi Task must execute verifiable repository tools, produce a reviewable change through the existing review and apply path, and expose consistent terminal results in Web and the public Skill before the route is claimed usable. That live-acceptance obligation is separate from code-level synthetic proof

Image smoke proves the selected binary, the shim, non-root identity, and that the host is present. It does not prove a real inference Turn.

The shared qualification cases in [Codex Worker Adapter](20260716-codex_worker_adapter.md#tests) apply to this runtime on the SDK host. A mocked adapter proves the Harness only. One runtime's pass does not qualify another. JSON mode and raw RPC are not alternate passing interfaces.

### Native Search Acceptance

These predicates qualify [the search-only native MCP decision](../decisions/20260930-pi_native_mcp_discovery.md) independently of Native Local Configuration.

These criteria use real-host fixtures and named expected failures so a registration-only or model-free mock cannot falsely accept the route.

1. **Activation and current native selection:** with an unrelated native active tool and a default-exposure local MCP server, the first captured provider request declares the genuine native tool_search without dropping the unrelated or managed direct tools. Exercise current authored defaultTools and the unconfigured native-default case. On an exact successor, assert the current native initial selection plus required search and native direct registrations, not automatic restoration of the predecessor's searched declarations. With changed built-in defaults, a newly selected default is present and a removed default is not revived solely from transcript history. A loaded-but-inactive search factory, singleton replacement, restrictive allowlist, or host union/replacement with the historical loadout fails this predicate. Check provider-visible schemas, not only helper return values.
2. **Three real exposure paths:** use local fixture servers for omitted/default `codemode`, explicit `codemode-deferred` and `deferred`. A scripted local provider first calls `tool_search`; the next captured provider request declares the matched tool's actual schema; a following tool call reaches the exact fixture server/tool and returns its unique sentinel through the real SDK host. The fixture must assert its invocation count and arguments, not just search's `details.loaded`. This synthetic provider proves host integration, not live model quality or deployed egress.
3. **Direct and hidden semantics:** managed tools are declared before any search with their admitted direct registration, exact id/URL and header-only loopback credential. Search does not create another client or registration. A hidden tool is absent from search results/declarations and cannot be invoked; search does not rewrite the source `mcp.json` or force all user tools direct. An empty managed catalog remains connected and ready.
4. **Wrong-target counterexamples:** through search followed by direct native calls, distinguish `read-file` from `read_file` and `work-files` from `work_files` in both registration orders. Assert the correct server's distinct effect/counter and zero calls to the other target for each invocation, even if both return successful-looking results. This protects the selected route from normalization elsewhere in the provider/SDK path; the research collision probe is not evidence that this regression already passes. If this route cannot prove exact targeting, block its affected qualification rather than falling back to scripts or renaming user configuration.
5. **Independent ownership:** excluded or replaced host MCP/search resources are restored by the final managed layer with warnings and unchanged user files. Native search and Gateway MCP calls must execute through the host implementations. Genuine factory failure refuses setup.
6. **Managed transport precedence:** agent-directory, project, disabled, stdio and Extension-authored entries sharing an admitted server name are replaced as complete entries. Assert exact Gateway requests and zero contact with the displaced native target. Pending or failed initialization remains unready; empty catalogs are ready.
7. **Authority and secrecy:** discovered tools run through native argument validation and `tool_call`/`tool_result` hooks. Managed calls retain current Turn/capability checks and revocation. Reflection in descriptions, search results, errors, resource blobs or logs must not expose either loopback credential; retain the existing pre-persistence redaction or fail the test. Search adds no Provider endpoint, credential, Gateway bypass or public-egress grant.
8. **Native capability:** user-configured codemode settings and setup-time composer registration permit a Turn. Model-directed shell commands and workspace file writes execute with observable effects. Default MCP discovery and ordinary namespaced tools remain usable, and managed-route, credential, cancellation and containment obligations remain in force.
9. **Lifecycle, pin-specific rediscovery and current authority:** two Turns in one resident host retain a searched tool's activation and one native MCP owner per server. After proved close/fence and exact successor resume, the native conversation and prior context remain intact, required search is active alongside current native startup/direct tools, and no tool effect is replayed. A formerly searched default/deferred tool absent from current native activation is initially undeclared. A scripted stale direct call receives the native unavailable-tool error with zero target effects; a subsequent native search declares the currently eligible tool with its actual schema, and a new exact-target call succeeds once. Changing the current exposure to hidden, withdrawing the registration or revoking managed capability must not be defeated by old transcript declarations or another search. Assert exact identity, retained byte-prefix preservation, per-host connection ownership and exact effect counts. Cancellation during setup or a discovered call, close and failure still prove the existing pending/connected transport and descendant cleanup. An SDK upgrade requalifies this behavior; the host does not restore it with private APIs, a second catalog or effect replay.
10. **Packaging and live boundary:** run the real-host fixture from the built deployment dependency closure as the non-root worker and record the exact image digest. Separately retain the adapter's real Task/provider and deployed Sandbox gates; neither imports nor a local synthetic MCP/server exchange closes them. Do not add a public network dependency to these local discovery regressions.

## Implementation Evidence And Limit

The paragraphs below record the JSON-mode implementation and the image observations through 2026-09-29. They are historical evidence of those bytes. The accepted design replaces this path with the official SDK host. A successor's different absent path in those probes is evidence of the old contract, not the new requirement. The `0.85.1` two-process file probe proves process replacement on that pin. It does not prove the SDK host, `pi-mcp-adapter`, or the shared image.

The current Pi `0.85.1` implementation uses per-Turn JSON-mode processes. It allocates a unique absent path for each AgentSession binding, launches every Turn in a fresh process with that exact path, proves the nonempty native header id and cwd before reuse, keeps the model descriptor Turn-private, preserves failed native bytes, removes only disposable control at close, and rejects mismatched admitted identity without an inode tracker. Its static registry entry, authored manifest, pinned worker image, adapter tests, and image smoke implement the controlled descriptor route. Complete live Task and review and apply acceptance remains outstanding, and the repository manifest remains disabled pending that proof. The 2026-07-21 arm64 image build and complete smoke, and the earlier minimal arm64 OpenShell `0.0.80` create, upload, generic-shim dry-run, and delete on A1, are historical evidence for the previous Pi `0.80.7` image contents. They are not `0.85.1` image evidence and prove neither the target NanoHost lifecycle nor RelayStream plus nested HTTP/2 feasibility. On 2026-09-05 this worktree built and smoked unique local tag `openkit/worker-pi:codex-pi-refresh-20260905` on Docker Engine 29.5.2 linux/aarch64 (image id `sha256:ba074c6f0caa0a52b9f3fd9ca0c87e6703f842f98966e0e506e1a8ad86a7b745`, smoke exit 0, native version `0.85.0`). That `0.85.0` unique-tag proof is historical for the previous pin. On 2026-09-06 this worktree built and smoked unique local tag `openkit/worker-pi:pi-0.85.1-refresh-20260906` on Docker Engine 29.5.2 linux/arm64 (image id `sha256:6cd46bcc208092417082152cf022a1818674f21bdcc921b02d6424c8e60662de`, smoke exit 0, native version `0.85.1`). That local unique-tag proof does not replace stock OpenShell, amd64 cross-build, real-provider, worker-control, heartbeat, interruption, reconnect, or recovery gates.

On 2026-09-29, an isolated native probe against pinned Pi `0.85.1` passed two separate processes using the same exact session file. The second request contained the first assistant response, retained the original Pi session id, and honored a changed admitted model. This proves process replacement on that pin, not the SDK host. Pinned upstream source also shows that a missing or empty explicit session path is silently initialized on that JSON-mode pin, which is why the removed path required absence before a first launch and a nonempty header before reuse.

After implementation on 2026-09-29, the built Pi adapter passed an isolated two-Turn native probe inside local image `openkit/worker-pi:pi-0.85.1-refresh-20260906`, whose native binary reports `0.85.1`. The probe selected a different absent path for a successor binding on the same retained state root. That successor behavior is the old contract. The probe used a synthetic loopback inference server and direct adapter operations. It does not prove the shared native process runner, live Gateway, NanoHost route, or Task acceptance.

This local unique-tag smoke proves image contents and adapter dry-run for the JSON-mode pin. It does not prove a real-provider turn, worker-control readiness, heartbeat, interruption, reconnect, or recovery lifecycle.

On 2026-09-06, the final Worker source `6bf9bfbc01eb4d8903dc71a45fb51e63646f5fb6` passed the catalog image build and smoke on both `linux/amd64` and `linux/arm64`. Its Pi leaf also passed stock OpenShell `0.0.99` create, AEP upload, generic-shim dry-run, and delete on A2. These observations close image-content checks for Pi `0.85.1` on the removed leaf. They are not the SDK-host acceptance bar.

The accepted design places the SDK host in `packages/pi-runtime-host`. The shim adapter in `packages/worker-shim/src/adapters/pi.ts` drives that host over its private channel and does not depend on the package or on any Pi package. The common-stage image must not copy the host. The runtime image installs the host executable at `/usr/local/bin/openkit-pi-runtime-host`.

On 2026-09-30, tests on the workspace-patched Pi 0.99.1 native MCP closure proved direct resident continuity, changed-model continuation within a fixed admitted route set, exact successor resume without idle capability contact, selected supply refusal and successor schema, supported resource loading, and common credential carriers. Real-host WorkerHarness tests against the merged lifecycle proved prior context and exact reference continuity, one resident process, bound POST routing, drain before normal collection, planned changed-supply replacement, proved-stop fault cleanup, bounded interrupt failure during model and tool work, and active resident close preserving retained bytes. Pi's standalone MCP GET receives local 405 without reaching the capability plane; initialized POST behavior continues normally. Controlled channel tests cover semantic and syntactic faults, active inspection failure, closed interrupt shapes, response and correlation deadlines, prior duplicates during a later Turn, actual stdout UTF-8 splits, shared rejecting close, and redacted observation bounds. The round-4 review found that late terminal evidence could bypass pending stop proof; the round-5 correction latches per-Turn stop ownership and tests mixed malformed/terminal and inspection/terminal sequences under refused kill, delivered signal without exit, and confirmed exit, retaining the later-effect oracle. Unproved stop rejects adapter settlement and retains Harness admission, capacity, and Thread fences. A truthful failed final status is permitted while cleanup remains unknown; normal drain, barrier, workspace publication, success, post-final output, capacity release, and successor admission are forbidden without proof. On accepted shared lifecycle base 3b6499b7, the unchanged refusal-first successor regression passes: the changed-supply attempt returns its typed pre-native refusal with zero native requests, Turn-local cleanup becomes clean, and an exact successor completes with retained context and changed schema. The shared runner honors the resident startTurn rejection contract and retains occupancy when disposable input cleanup is unproved. The adapter consumes N4b's exact allowed routes without fallback, refuses changed sets or descriptors before native requests, and uses existing host configure for an admitted preference. Fixed-port test files have runner-owned serialization without port retries. Host qualification applies only to its named output, native MCP, local MCP, credential, cancellation, compaction, and Extension run-fencing behavior. Image, live Task, review/apply, Web/public Skill, workspace collection, transport adoption, and NanoCore restart acceptance remain separate. AEP Skill targets and native runtime provenance have no channel projection; actual-outcome races remain their shared owner's scope.

On 2026-10-01, M4 real-host fixtures on the patched Pi 0.99.1 closure proved native search for all three supported exposures and exact colliding targets in both orders. The round-7 retained-loadout failure records the defeated restoration premise; the primary seated the Consultant's option B within existing M3/M4 authority. New and exact-successor hosts use current native settings and registrations plus additive search; resident Turns preserve searched activation. Real-child regressions cover changed, unchanged and unauthored defaults, correlated stale-call refusal with zero effects, exact-successor native rediscovery and one new exact-target effect, folded native tool deltas and retained byte prefixes. This is pin-specific behavior despite upstream restoration intent, not a deliberate-upstream-reset claim. An SDK upgrade requires requalification. Image, deployed production closure, live provider and Sandbox gates remain separate.

On 2026-10-01, Native Local Configuration uses Pi 0.99.1's trusted-project settings and MCP loaders, native context and prompt precedence, and separate native loading of selected Skills alongside independently discovered resources. Local Skill name collisions use the selected managed binding; resident selected-supply changes refuse before work. This pin has no separate system-default settings layer; image authors use the image user's ordinary `$HOME/.pi/agent`. The shim initializes only an absent retained `<stateRoot>/agent` through validated sibling staging, refuses unreadable or escaping sources and leftover staging before host spawn, and preserves existing homes across source changes and exact successor resume. Real-host synthetic-loopback regressions prove these behaviors with both nonempty and empty selected supply, searched local MCP and managed MCP, benign model-default shadowing, managed setup-time provider and model precedence, native auth isolation and native search discovery. Later user Extension execution is outside this setup qualification under the [Sandbox full-capability rulings](../decisions/20261001-sandbox_full_capability_rulings.md). These are local pin qualifications, not image, live-provider or deployed Sandbox acceptance.

The Reasoning Effort Delivery contract above is an accepted target awaiting implementation. The current adapter does not deliver the recorded per-Turn override through the SDK host or supply its explicit native thinking-level map.

## Acceptance

This adapter is clean only when deleting it removes all Pi command, JSON, and resource-isolation knowledge without changing NanoCore, the shared Harness contract, or canonical worker schemas. The deployment image is shared and is not deleted with the adapter.

Pi proves the intended extensibility only when it is added as one AgentManifest, one adapter module plus its static registry entry, and one `targetRuntime` selection inside the sole deployment image, rather than as a new NanoCore runtime path.

## Upstream Evidence

The links below document the examined `0.85.1` JSON-mode pin. They are not the SDK deployment pin.

- `https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/README.md`
- `https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/models.md`
- `https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/json.md`
- `https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/rpc.md`
- `https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/types.ts`
- `https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/types.ts`
- `https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts`
- `https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts`
- `https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/session-manager.ts`
- `https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/modes/print-mode.ts`
- `https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/test/suite/agent-session-retry-events.test.ts`
- `https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/test/suite/regressions/6363-agent-settled-event.test.ts`

## Related Documents

- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260721-worker_execution_environment_images.md`
- `docs/specs/20260716-codex_worker_adapter.md`
