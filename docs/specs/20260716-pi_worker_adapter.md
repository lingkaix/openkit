---
status: Accepted
implementation: Partial
kind: boundary
updated: 2026-09-30
---
# Pi Worker Adapter

## Generic Volume Retention Amendment

[Persistent Worker Volumes](20260910-persistent_worker_volumes.md) owns complete opaque data/home volumes and supersedes this adapter's deletion of native data at ordinary Turn or AgentSession close. The adapter preserves its admitted stable Thread-private data directory intact, without a list of known filenames. Generated launch and control material remains in separate ephemeral roots. Opening or closing a native binding must not recursively erase the retained data directory. Closing invalidates the exact binding and restricted handle, proves writer absence, and preserves the exact Pi session file with every other retained byte. Retained native histories, memory, configuration, and unknown files do not select a conversation, do not grant tools or credentials, and do not become launch authority.

Official SDK operations, event translation, and feature restrictions remain owned here. Whole-volume retention alone does not discover a session or grant hooks, ambient configuration, tools, or credentials as launch authority. A successor resumes the exact retained session under [AgentSession](../core/agent-session.md). Resume is by that exact retained reference only. Native-session discovery and continuation by an unauthorized binding remain forbidden. An authorized successor AgentSession resumes only the exact retained reference after its predecessor is closed or fenced.

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

The SDK host pins `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` at exactly `0.99.1` and uses that release's native MCP. On this pin the host calls that release's configuration loader with the admitted agent directory, the session cwd, and `projectTrusted: false`, and it requires the host-supplied built-in MCP Extension when OpenKit servers are admitted. The deployment image pin remains the `worker-runtimes` version manifest. The image pin `0.85.1` at monorepo commit `d981de1229ef899957bbe968bc8dcda02a21f477`, and the published `0.87.1` commit `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`, are examined evidence of earlier pins. Main commit `4df1574339bfbd1a9750ff485bb618da397ba135` is not a pin for `0.87.1`.

The production path is the SDK host. The adapter spawns no shell and never uses `--api-key`. JSON-mode argv, including `--mode json`, `--no-approve`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, and `--offline`, is not the contract.

Native permission prompts are disabled inside the Sandbox ([Sandbox](../core/sandbox.md), [full permission inside the Sandbox](../decisions/20260930-full_permission_inside_the_sandbox.md)). The workspace is already governed, and disabling prompts grants nothing beyond that. If a native permission request arrives anyway, the adapter selects an offered `reject_once` option, or cancels the prompt and records the request when none is offered. It never selects an allow option. Unselected ambient saved sessions and retained settings are not launch authority. Themes and ambient context files are not turned on.

User packages, file-based Extensions, Skills, and prompt templates load through Pi's normal settings and resource loader with an explicit agent directory, from image contents or authorized retained or mounted files. Dockerfile installation is not enough if the files land in the wrong home or only in a shell startup file. The host must not replace the resource loader with a hardcoded OpenKit tool list. An installed package is not a supported feature until its behavior is proved. Headless-incompatible UI features, including UI-only panels, shortcuts, and prompts, return an explicit unsupported result. A module that loaded is not by itself a compatible feature. Browser and tool environment variables must reach the non-interactive runtime. Extensions must not read Integration control credentials or mutate another binding.

## AEP Inputs Consumed

The shared Harness supplies the adapter with:

- adapter id `pi`
- turn input
- worker working directory
- the admitted retained state root and the exact retained session reference when one exists
- the preferred and allowed logical-model contract plus the sandbox-local inference binding
- the two session-local loopback credentials, and no worker-control credential

The adapter does not choose provider credentials, trust arbitrary project resources, enable network sources, or override AEP policy.

The worker-control token does not enter the host. The two loopback credentials replace upstream inference and capability tokens in the native process. The native field or SDK call that carries each credential is established by probe and is not named here. Credential refresh must not fall back to an old environment value, a stored provider credential, or another binding.

## Session Operations

Successive Turns use one native session in one host. Pi defers native session creation and SDK open to the first Turn. `session.open` starts the resident executable and private channel, creates the explicit agent directory, and validates an exact resume reference before spawning, but sends no native open or prompt and makes no capability contact. The first bound Turn supplies the working directory, model, and MCP server ids; it opens the SDK session and creates a new conversation or resumes the exact proved conversation before prompting. Inspection before that Turn returns `pending` for a new conversation, or `ready` for the exact successor reference after repeating its retained header proof while the host is live. A failed first Turn grants no reusable authority, including when its user message was persisted. `session.open` carries `resume: { locator, digest } | null`. The raw reference stays in retained Sandbox storage outside the disposable control root. Core stores the locator and the digest. The JSONL itself remains retained data and is not, by itself, permission to resume.

The candidate path is a strict child of the admitted state root. The adapter never discovers, selects, truncates, or replaces some other retained file. The successor is handed the exact retained reference.

Missing, empty, malformed, symlinked, wrong-id, or wrong-cwd identity fails before work. A missing file is a failure, not a new conversation. The restricted handle consists only of this exact path and header identity and exposes only its digest and state through the shared Harness. An indistinguishable file with the same admitted path, header id, and cwd satisfies this proof. The adapter adds no inode or byte-history tracker.

`turn.start` prompts the resident session. The admitted logical model may change across Turns while the exact conversation continues. Collection requires that Turn's provider and model. Model and tool selection are SDK operations at a declared boundary, normally before the next Turn. Compaction can occur inside a prompt. The adapter retains Pi's native entry graph and records only compaction identities actually observed.

`turn.interrupt` reports the actual outcome and does not close the session. `session.inspect` repeats the identity proof without launching work and distinguishes this host from a replacement. An unknown or mismatched identity fails closed and launches no work. `session.close` stops work, finishes cleanup, and terminates that dedicated host, preserving the session file and every other retained byte, and proves writer absence. `harness.drain` is the Harness admission fence. While admitted work and cleanup settle, this adapter refuses new `session.open` and `turn.start`. The Harness owns that fence. This adapter does not invent a native drain RPC.

The six operations `session.open`, `session.inspect`, `turn.start`, `turn.interrupt`, `session.close`, and `harness.drain` are owned by [Worker Control Protocol](20260703-worker_control_protocol.md#harness-control-operations). This section maps them onto the open, inspection, prompt, interrupt, close, and admission-fence behavior above.

A host exit ends that AgentSession. A transport loss and a NanoCore restart may each adopt the exact surviving binding, including its lineage, sequence, and lease, under the existing continuity and NanoHost proof contracts, with no duplicate effect. A binding that cannot be proved exactly is closed or fenced, and a successor resumes only the exact retained reference. A NanoCore restart does not by itself end the binding. Failed or interrupted collection returns no new ready authority. A failure after native bytes were written fails the Turn without rolling back, truncating, deleting, or repairing the retained file. The adapter does not infer that a failed OpenKit Turn left no native effect.

No environment variable, AEP extension, test option, or image diagnostic may replace the adapter-produced native operations. Tests inject a runner or a static test adapter without creating a production command override, and NanoCore never constructs a Pi command.

## Native Output Mapping

The adapter requires one settled, correlated successful assistant outcome for the admitted prompt. The provider and model must equal the admitted launch. It rejects an error, an abort, length exhaustion, terminal tool-use without a completed continuation, an unresolved retry, and contradictory terminal evidence. It concatenates explicit text content in order with no inserted separators, trims the combined boundary once, and requires a non-empty combined result. Settlement does not require process exit. An admission acknowledgement, an assistant or tool cycle end, or an intermediate agent end is not the completed Turn. Unknown events are ignored and cannot satisfy a lifecycle predicate. Tool and extension envelopes stay inside the adapter. They do not enter `packages/worker-protocol` or NanoCore.

Native result content is limited to 16 MiB. The shared process runner retains at most a 16 KiB prefix from each of stdout and stderr for failure diagnostics before redaction. The JSON-mode event names `agent_settled`, `message_end`, `turn_end`, and `agent_end` are historical names of the removed path, not the SDK product schema.

The adapter returns a normalized final assistant message and adapter-local diagnostics. The shared Harness writes schema-conformant candidate records, and NanoCore alone validates and commits canonical product state. Live native token streaming into product Items is not supported.

## Control Mapping

- `turn.interrupt` uses the host's native cancel, reports the actual outcome, and does not close the session by itself.
- Steer and follow-up are not advertised and are not active-turn product controls.
- Extension UI requests and responses are an explicit unsupported result. They are not a product approval channel and are not mapped to approvals or questions.
- Pi RPC does not enter NanoCore.

## Skills, Extensions, And MCP

The host requires the workspace-patched `@earendil-works/pi-coding-agent@0.99.1`: `pnpm-workspace.yaml` applies `patches/pi-coding-agent-0.99.1-openkit-native-state.patch` to expose `McpExtensionOptions.onConnectionState`, which stock 0.99.1 does not provide. The private configuration-loader and default-transport imports resolve from that same pinned package. An image must deploy the built host with its patched production dependency closure; a plain npm installation of Pi is not equivalent.

OpenKit-managed MCP uses Pi 0.99.1's native MCP. The host registers each admitted server for the resident session with `exposure: "direct"`, so those tools are declared to the model, at `<capabilityBaseUrl>/mcp/<serverId>` with the capability loopback credential only in the `Authorization` header. User in-Sandbox MCP uses `<agentDir>/mcp.json` under Pi's own loader. The project `mcp.json` stays unread because the host does not trust the project. One server must not have two clients. The host invokes Pi's own loader with the admitted agent directory, the session cwd, and `projectTrusted: false`, and fails setup when that returned configuration contains an admitted name, including a disabled entry and an entry written during Extension loading. It requires the host-supplied built-in MCP Extension to remain loaded, and fails setup when that Extension is disabled or replaced, even if a replacement could connect the registrations. An empty tool catalog is a successful connection. Both loopback credentials are redacted from native MCP JSON messages, including member names and decoded resource blobs, and from native transport errors before Pi converts or persists them. Connection proof is Pi's completed setup and tool registration callback for each admitted server; terminal failure follows native retry handling. `@earendil-works/pi-coding-agent` is not added to `@openkit/worker-shim`.

The adapter must not discover, install, directly connect, authorize, or broaden OpenKit MCP supply. Undeclared or unauthorized Extension loading is an image or manifest policy failure, not a reason to broaden the adapter. The adapter declares whether the runtime lists tools again at Turn start. The implementation slice establishes that declaration by probe. When it does not, a changed supply is a setup change replaced by a successor AgentSession that resumes the native conversation ([AgentSession](../core/agent-session.md)). Narrowing and revocation apply at the next call as `capability_denied`. [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md) owns the Gateway plane for external systems. In-Sandbox MCP is unrestricted.

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
- Undeclared or unauthorized Extension loading is an image or manifest policy failure, not a reason to broaden the adapter.
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

## Tests

Required adapter tests cover:

- Identity preflight of the exact nonempty session header id and cwd before work, rejection of missing, empty, malformed, symlinked, wrong-id, wrong-cwd, or otherwise mismatched identity, and no inode tracker
- Close preserving the session file and every other retained byte, and rejection of any file other than the exact retained reference
- Credential-value absence, direct-route rejection, and no `--api-key`
- Changed-model continuation of the exact conversation, with that Turn's provider and model required at collection
- Unknown-event tolerance, the 16 MiB and 16 KiB bounds, one settled correlated successful outcome, rejection of error, abort, length exhaustion, terminal tool-use without a completed continuation, unresolved retry, and contradictory terminal evidence, ordered text concatenation with no inserted separators, one trim of the combined boundary, a non-empty combined result, and settlement without requiring process exit
- Inspection of the exact host and session without launching work, rejection of an unknown or mismatched identity, and `harness.drain` refusing new `session.open` and `turn.start` while admitted work and cleanup settle
- Ephemeral isolation from retained prompts and stale auth, so retained files do not become launch authority
- Two prompts in one SDK host, then a new host resuming the exact session file, with the prior context visible in the captured provider input
- SDK Extension lifecycle and authority removal: user package loading, a session-start hook, a Skill or template, one sandbox-local MCP server, OpenKit MCP exactly once through Pi's native registration, refusal when the loader returns an admitted name or the host-supplied built-in Extension is replaced, a successful empty catalog, redaction of both loopback credentials in native log and reflected tool-result delivery, a browser path reaching the runtime, and an explicit unsupported result for a UI-only feature. Module load is not compatibility
- A supply change between two Turns either shows the new supply on the second Turn or follows the probed setup-change successor. The check reads the model-visible schema
- Fail-closed native permissions
- A real Pi Task must execute verifiable repository tools, produce a reviewable change through the existing review and apply path, and expose consistent terminal results in Web and the public Skill before the route is claimed usable. That live-acceptance obligation is separate from code-level synthetic proof

Image smoke proves the selected binary, the shim, non-root identity, and that the host is present. It does not prove a real inference Turn.

The shared qualification cases in [Codex Worker Adapter](20260716-codex_worker_adapter.md#tests) apply to this runtime on the SDK host. A mocked adapter proves the Harness only. One runtime's pass does not qualify another. JSON mode and raw RPC are not alternate passing interfaces.

## Implementation Evidence And Limit

The paragraphs below record the JSON-mode implementation and the image observations through 2026-09-29. They are historical evidence of those bytes. The accepted design replaces this path with the official SDK host. A successor's different absent path in those probes is evidence of the old contract, not the new requirement. The `0.85.1` two-process file probe proves process replacement on that pin. It does not prove the SDK host, `pi-mcp-adapter`, or the shared image.

The current Pi `0.85.1` implementation uses per-Turn JSON-mode processes. It allocates a unique absent path for each AgentSession binding, launches every Turn in a fresh process with that exact path, proves the nonempty native header id and cwd before reuse, keeps the model descriptor Turn-private, preserves failed native bytes, removes only disposable control at close, and rejects mismatched admitted identity without an inode tracker. Its static registry entry, authored manifest, pinned worker image, adapter tests, and image smoke implement the controlled descriptor route. Complete live Task and review and apply acceptance remains outstanding, and the repository manifest remains disabled pending that proof. The 2026-07-21 arm64 image build and complete smoke, and the earlier minimal arm64 OpenShell `0.0.80` create, upload, generic-shim dry-run, and delete on A1, are historical evidence for the previous Pi `0.80.7` image contents. They are not `0.85.1` image evidence and prove neither the target NanoHost lifecycle nor RelayStream plus nested HTTP/2 feasibility. On 2026-09-05 this worktree built and smoked unique local tag `openkit/worker-pi:codex-pi-refresh-20260905` on Docker Engine 29.5.2 linux/aarch64 (image id `sha256:ba074c6f0caa0a52b9f3fd9ca0c87e6703f842f98966e0e506e1a8ad86a7b745`, smoke exit 0, native version `0.85.0`). That `0.85.0` unique-tag proof is historical for the previous pin. On 2026-09-06 this worktree built and smoked unique local tag `openkit/worker-pi:pi-0.85.1-refresh-20260906` on Docker Engine 29.5.2 linux/arm64 (image id `sha256:6cd46bcc208092417082152cf022a1818674f21bdcc921b02d6424c8e60662de`, smoke exit 0, native version `0.85.1`). That local unique-tag proof does not replace stock OpenShell, amd64 cross-build, real-provider, worker-control, heartbeat, interruption, reconnect, or recovery gates.

On 2026-09-29, an isolated native probe against pinned Pi `0.85.1` passed two separate processes using the same exact session file. The second request contained the first assistant response, retained the original Pi session id, and honored a changed admitted model. This proves process replacement on that pin, not the SDK host. Pinned upstream source also shows that a missing or empty explicit session path is silently initialized on that JSON-mode pin, which is why the removed path required absence before a first launch and a nonempty header before reuse.

After implementation on 2026-09-29, the built Pi adapter passed an isolated two-Turn native probe inside local image `openkit/worker-pi:pi-0.85.1-refresh-20260906`, whose native binary reports `0.85.1`. The probe selected a different absent path for a successor binding on the same retained state root. That successor behavior is the old contract. The probe used a synthetic loopback inference server and direct adapter operations. It does not prove the shared native process runner, live Gateway, NanoHost route, or Task acceptance.

This local unique-tag smoke proves image contents and adapter dry-run for the JSON-mode pin. It does not prove a real-provider turn, worker-control readiness, heartbeat, interruption, reconnect, or recovery lifecycle.

On 2026-09-06, the final Worker source `6bf9bfbc01eb4d8903dc71a45fb51e63646f5fb6` passed the catalog image build and smoke on both `linux/amd64` and `linux/arm64`. Its Pi leaf also passed stock OpenShell `0.0.99` create, AEP upload, generic-shim dry-run, and delete on A2. These observations close image-content checks for Pi `0.85.1` on the removed leaf. They are not the SDK-host acceptance bar.

The accepted design places the SDK host in `packages/pi-runtime-host`. The shim adapter in `packages/worker-shim/src/adapters/pi.ts` drives that host over its private channel and does not depend on the package or on any Pi package. The common-stage image must not copy the host. The runtime image installs the host executable at `/usr/local/bin/openkit-pi-runtime-host`.

On 2026-09-30, tests on the workspace-patched Pi 0.99.1 native MCP closure proved direct resident continuity, changed-model continuation within a fixed admitted route set, exact successor resume without idle capability contact, selected supply refusal and successor schema, supported resource loading, and common credential carriers. Real-host WorkerHarness tests against the merged lifecycle proved prior context and exact reference continuity, one resident process, bound POST routing, drain before normal collection, planned changed-supply replacement, proved-stop fault cleanup, bounded interrupt failure during model and tool work, and active resident close preserving retained bytes. Pi's standalone MCP GET receives local 405 without reaching the capability plane; initialized POST behavior continues normally. Controlled channel tests cover semantic and syntactic faults, active inspection failure, closed interrupt shapes, response and correlation deadlines, prior duplicates during a later Turn, actual stdout UTF-8 splits, shared rejecting close, and redacted observation bounds. The round-4 review found that late terminal evidence could bypass pending stop proof; the round-5 correction latches per-Turn stop ownership and tests mixed malformed/terminal and inspection/terminal sequences under refused kill, delivered signal without exit, and confirmed exit, retaining the later-effect oracle. Unproved stop rejects adapter settlement and retains Harness admission, capacity, and Thread fences. A truthful failed final status is permitted while cleanup remains unknown; normal drain, barrier, workspace publication, success, post-final output, capacity release, and successor admission are forbidden without proof. On accepted shared lifecycle base 3b6499b7, the unchanged refusal-first successor regression passes: the changed-supply attempt returns its typed pre-native refusal with zero native requests, Turn-local cleanup becomes clean, and an exact successor completes with retained context and changed schema. The shared runner honors the resident startTurn rejection contract and retains occupancy when disposable input cleanup is unproved. The adapter consumes N4b's exact allowed routes without fallback, refuses changed sets or descriptors before native requests, and uses existing host configure for an admitted preference. Fixed-port test files have runner-owned serialization without port retries. Host qualification applies only to its named output, native MCP, local MCP, credential, cancellation, compaction, and Extension run-fencing behavior. Image, live Task, review/apply, Web/public Skill, workspace collection, transport adoption, and NanoCore restart acceptance remain separate. AEP Skill targets and native runtime provenance have no channel projection; actual-outcome races remain their shared owner's scope.

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
