---
status: Accepted
implementation: Partial
kind: boundary
updated: 2026-09-29
---
# Pi Worker Adapter

## Generic Volume Retention Amendment

[Persistent Worker Volumes](20260910-persistent_worker_volumes.md) owns complete opaque data/home volumes and supersedes this adapter's deletion of native data at ordinary Turn or AgentSession close. The adapter preserves its admitted stable Thread-private data directory intact, without a list of known filenames. Pi reads native configuration from the separate ephemeral launch directory defined below; retained native configuration does not become launch authority. Generated launch/control material remains in separate ephemeral roots. Opening or closing a native binding must not recursively erase the retained data directory; closing invalidates the exact binding and restricted handle, proves writer absence, and preserves the exact Pi session JSONL with every other retained byte. Retained native histories, memory, configuration and unknown files do not select a conversation or grant tools or credentials.

The pinned native command, result parser and feature restrictions remain owned here. Whole-volume retention alone does not enable native session resume, hooks, extensions, saved-session discovery or ambient configuration. Supported resume requires the current AgentSession's exact private handle proof under Native Session Continuity; every other binding starts a fresh native conversation even when old Pi session files remain in the same retained work slot.

## Summary

The Pi Worker Adapter translates one resolved Agent Environment Package into one bounded Pi Coding Agent process and translates Pi's machine-readable native event stream into the shared OpenKit worker harness result.

Sequential Turns of the same AgentSession preserve exact native conversation continuity while each Turn launches a fresh Pi process.

Pi is the third concrete runtime challenge. Its purpose in this architecture is to prove that the worker boundary is not an accidental Codex/OpenCode common denominator.

This adapter uses the shared registry's existing `session-continuity` mode and its five operations. Each Turn launches a fresh Pi process against either one fresh absent session path or the exact retained JSONL named by the current AgentSession's restricted handle. This change adds no Pi RPC client, durable record, runtime protocol, NanoHost behavior, native-session discovery, or cross-AgentSession continuation.

## Owns

- Pi command construction for one bounded worker turn
- exact Pi native-session resume inside the current AgentSession binding
- bounded parsing of Pi JSON events
- final assistant content extraction from Pi-native message records
- Pi-native session path, header, inspection and close proof inside the shared five-operation continuity contract
- Pi-specific version, event compatibility, and failure tests
- Pi-specific failure mapping and conformance evidence for manifest-declared capabilities

## Does Not Own

- child process supervision, worker control, canonical transcripts, or workspace publication
- AEP resolution, logical-model selection, Gateway routing, credential grants, network policy, or backend lifecycle
- product state, scheduling, review, apply, Action Center, or public API behavior
- a generic RPC client or interactive terminal UI
- a translation of every Pi extension or UI event into OpenKit product events

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-supply.md`
- `docs/core/sandbox.md`

## Upstream Contract

The accepted upstream research pin is Pi monorepo commit `d981de1229ef899957bbe968bc8dcda02a21f477`, whose coding-agent package reports version `0.85.1`.

Each native Turn uses JSON mode with one exact adapter-selected session path and all ambient resource and approval paths disabled:

```text
pi --mode json --no-approve --session <exact-session-path> --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --offline --provider <provider> --model <model> <turn-input>
```

The safe child environment sets `PI_CODING_AGENT_DIR` to the fresh Turn-private ephemeral launch directory, plus `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`, and the existing distinct inference credential environment variable. The adapter spawns the argv directly without a shell and never uses `--api-key`.

Pi also provides newline-delimited JSON RPC mode with native commands including prompt, steer, follow-up, abort, session operations, and extension UI request and response. OpenKit does not adopt RPC mode because process replacement plus `--session` supplies the required continuity while only interrupt has a current shared control mapping.

Pi's native Skill and MCP execution remain disabled in this change. Their existence does not change OpenKit's supply or capability boundary.

## AEP Inputs Consumed

The shared harness supplies the adapter with:

- adapter id
- turn input
- worker working directory
- session directory
- the preferred and allowed logical-model contract plus the sandbox-local `inference.local` binding
- a safe child environment without the worker-control or capability token; any target inference binding uses its own distinct inference credential

The adapter does not choose provider credentials, trust arbitrary project resources, enable network sources, or override AEP policy.

## Launch Plan

`prepareTurn` materializes the one adapter-owned native model descriptor defined under Provider And Credentials before returning the exact native launch command, safe Pi environment, and request for bounded exact stdout capture. The plan has no config-artifact field; the shared Harness does not interpret Pi configuration.

The fixed fail-closed flags prevent the image from silently loading project extensions, Skills, prompt templates, themes, context files, or unselected ambient saved sessions. `--no-approve` bypasses project-trust approval for the already governed workspace; it is not a general approval-state control. The ephemeral `PI_CODING_AGENT_DIR` isolates generated configuration from retained native files. Pinned discovery restrictions and current AEP authority continue to control what can execute. Preparation rejects an unsupported authority-bearing field rather than loading retained settings or deleting retained data to obtain a clean run.

No environment variable, AEP extension, test option, or image diagnostic may replace the adapter-produced argv. Tests inject a process runner or a static test adapter without creating a production command override, and NanoCore never constructs a Pi command.

The adapter contract has no separate interrupt operation. The shared harness owns process-group termination.

## Native Session Continuity

Pi implements the existing `openSession`, `prepareTurn`, `collectTurn`, `inspectSession`, and `closeSession` interface without changing that interface. `openSession` creates one fresh disposable control binding and selects one fresh exact JSONL path under the binding's admitted retained work-slot state root. That candidate selection exists only in private control state, is a strict child of the state root, and must name an absent path; the adapter never discovers, selects, truncates, replaces, or resumes another retained Pi file.

A pending `prepareTurn` rechecks that its exact candidate path is absent immediately before spawn because Pi `0.85.1` silently creates a missing or empty `--session` path. A ready `prepareTurn` instead requires the exact path to be a nonempty regular file and requires its first complete JSONL record to be a Pi session header with the restricted handle's nonempty session ID and the exact current worker cwd. Missing, empty, malformed, symlinked, wrong-ID, wrong-cwd, or otherwise mismatched admitted identity fails before spawn. The restricted handle consists only of this exact path and header identity, remains inside the AgentSession-private control binding, and exposes only its digest and state through the shared Harness. An indistinguishable file with the same admitted path, header ID, and cwd satisfies this proof; the adapter adds no inode or byte-history tracker.

The first successful `collectTurn` establishes `ready` only after normal zero-status process exit, exact terminal output correlation under Native Output Mapping, and the same nonempty session-header proof. Later Turns start new Pi processes with the same exact `--session` path after the ready preflight. Each Turn still generates its own ephemeral model descriptor from current AEP authority, so the admitted logical model may change while Pi continues the exact prior conversation; collection continues to require that Turn's Provider alias and model.

`inspectSession` repeats the ready preflight without launching Pi. `closeSession` removes the disposable control/session namespace and restricted handle while preserving the retained JSONL and every other byte under the work-slot state root. A later AgentSession binding selects a different absent path and receives no authority to discover or resume the closed binding's file.

Failed or interrupted collection returns no new ready authority. A failure after native bytes were written, including adapter-local observation-capture finalization, fails the Turn without rolling back, truncating, deleting, or repairing the retained JSONL; the existing failed-closeout lifecycle closes the exact binding before reuse. The adapter does not infer that a failed OpenKit Turn left no native effect.

## Native Output Mapping

`collectTurn` parses Pi stdout as newline-delimited JSON under the shared 16 MiB native-output bound. Exceeding the bound fails collection closed.

It extracts final assistant content only after the pinned Pi stream reaches exactly one final `agent_settled` following normal zero-status exit without interruption. Within the final low-level run before that settlement, the accepted candidate is the last `message_end.message` whose `role` is `assistant` and whose `stopReason` is `stop`; a later `turn_end.message` and the last assistant message in a later `agent_end` with `willRetry=false` must each be structurally identical to that complete message. The final correlated message's provider and model must also equal the exact provider and model requested by the launch plan; missing or mismatched values fail closed instead of accepting Pi's fuzzy or synthetic model resolution. The adapter preserves only `content` entries with `type="text"` in array order, concatenates their strings without inserting separators, trims the combined boundary once, and requires a non-empty result. `error`, `aborted`, `length`, or terminal `toolUse`, `agent_end` with `willRetry=true` and no later completed run, missing or multiple settlement records, missing or contradictory correlation, malformed known records, and non-zero or signaled native exit fail collection closed. Unknown event types remain ignored for forward tolerance and cannot satisfy any required lifecycle predicate.

Pi-native tool events, extension UI events, model messages, session state, and RPC envelopes remain inside the adapter. They do not enter `packages/worker-protocol` or NanoCore.

The adapter returns a normalized final assistant message and adapter-local diagnostics. The shared harness writes schema-conformant candidate records, NanoCore alone validates and commits canonical product state, and the harness retains at most a 16 KiB prefix from each of stdout and stderr for failure diagnostics before redaction.

## Control Mapping

- current `interrupt` terminates the supervised Pi process group through the shared harness
- Pi RPC `abort` is semantically compatible with interrupt but is not required by the current JSON-mode path
- Pi RPC `steer` and `follow_up` are not advertised because OpenKit has not accepted corresponding active-turn controls
- Pi extension UI requests and responses are not mapped to approvals or questions until an explicit OpenKit product contract is accepted and tested

The Pi adapter implements only the shared five session-continuity operations; it does not implement an adapter-local interrupt or RPC operation.

If a future requirement adopts RPC mode, it must reuse the same adapter boundary and shared worker-control protocol. It must not introduce Pi RPC into NanoCore.

## Skills, Extensions, And MCP

Native Skills and extensions remain disabled by the fixed launch flags. This change does not activate callable MCP or worker-capability execution, and the adapter must not scan arbitrary locations, install packages, or enable undeclared resources.

Pi does not need native MCP support to satisfy the OpenKit boundary. The selected MCP capability plane is currently implemented only by the Codex adapter; Pi remains ineligible and must not add a direct policy-bypassing path.

## Provider And Credentials

The accepted NanoHost runtime exposes the logical worker-local `inference.local` binding at fixed `http://127.0.0.1:17892/inference/v1`, projected by Sandbox Integration through `/inference/*` with an inference credential distinct from `/worker-control/*` and `/capabilities/*`. Pi must not receive a direct NanoCore endpoint, the worker-control token, an SSH or Gateway-forward route, or a second control path. The adapter may project this fixed target through the bounded native descriptor below. No upstream subscription credential is passed to Pi.

The authored Agent Manifest owns logical-model preferences, credential requirements, backend-capability requirements, and network needs; the resolved AEP owns the exact allowed logical-model contract, credential bindings, and effective launch policy while the Gateway privately owns Provider routes. Pi `0.85.1` uses its native `models.json` custom-Provider path to consume this target. The adapter must not use `--api-key`, patch or fork Pi, expose a concrete upstream Provider route, or silently replace worker-local inference with a direct route. The engineer-approved reason for replacing the blanket generated-file prohibition is recorded in [Controlled Pi Model Configuration](../decisions/20260929-pi_controlled_model_configuration.md).

The adapter generates exactly one `models.json` in a fresh Turn-private ephemeral directory. It contains one adapter-owned Provider alias, the fixed `inference.local` base URL, the supported OpenAI-compatible protocol, and the exact admitted logical model with its effective context, output and modality parameters. It is a projection of the current resolved AEP, never a second model catalog or authored configuration source. Arbitrary project files, retained native configuration, caller-provided native JSON, shell-command credential resolvers, and concrete upstream URLs are not merged into it.

The descriptor references the existing inference credential as `$OPENKIT_WORKER_INFERENCE_TOKEN`; it must not contain the credential value, a subscription secret, or a worker-control/capability token. The safe child environment supplies that distinct inference credential. The alias and logical model passed to `--provider` and `--model` must match the final correlated native result under Native Output Mapping.

Generation completes before native spawn. Missing or conflicting selected-model authority, missing effective model parameters or inference credential, an unsupported endpoint/protocol, or a write failure stops preparation before spawn without a direct-provider fallback. Each new attempt regenerates the descriptor from its own admitted inputs; restart does not resume from a stale descriptor. Existing Turn-control cleanup removes the ephemeral directory only after the native process has stopped, including failure and interruption. Retained workspace and native data remain untouched. The descriptor adds no durable record, migration, RPC operation, MCP capability, or authority beyond the exact current AgentSession handle.

The historical Pi adapter accepted only the pinned `anthropic` / `claude-sonnet-4-5` direct pair with the manifest-declared `ANTHROPIC_API_KEY` credential binding, which the image smoke proved existed exactly in Pi's catalog. It passed that exact pair through `--provider` and `--model`, rejected zero or multiple routes, and failed before spawn when the pair or credential binding differed. Pi's fuzzy and synthetic model fallback was never accepted as route resolution. This direct credential path is historical evidence, not current NanoHost guidance.

## Manifest And Image Contract

The repository-owned Pi AgentManifest selects adapter id `pi`, the Pi worker image, native executable paths used by network policy, the logical-model preferences for the admitted inference route, resource-discovery isolation flags, and only capabilities proven by this specification. The active route does not require a direct upstream credential binding.

The Pi image installs the generic worker shim and `@earendil-works/pi-coding-agent@0.85.1`, sets the generic shim as its entrypoint, runs as a non-root worker user, and contains no Codex or OpenCode runtime. Its smoke check must verify the exact native version, JSON mode, generic shim dry run, fixed resource-isolation flags, ephemeral configuration projection, non-root identity, and expected worker filesystem layout. Image-content proof alone does not make Pi dispatch-ready without a real inference Turn.

Pi-specific install commands, binary paths, resource flags, event fixtures, and version pins live only in the Pi AgentManifest, adapter, image, specification, and tests.

## Failure Semantics

- malformed or over-limit native JSON output fails adapter collection closed
- missing trustworthy final assistant content fails collection when the native run claims success
- a non-zero native exit returns a failed adapter classification with bounded, redacted diagnostics
- interruption wins over partial assistant content
- worker-control failure stops Pi through the shared harness
- undeclared resource or extension loading is an image/manifest policy failure, not a reason to broaden the adapter
- pending creation rejects a present path, and ready inspection rejects missing, empty, malformed, symlinked, wrong-ID, wrong-cwd, or otherwise mismatched admitted identity before spawn
- the harness preserves the admitted Pi data root after collection, while only the current AgentSession's disposable control binding retains exact resume authority

## Capability Declaration

The authored manifest is the sole launch-time capability declaration. Adapter conformance and image smoke prove that the manifest advertises only the following supported behavior; `prepare` does not return a second capability declaration:

- bounded turn execution: supported
- same-AgentSession native JSONL continuation in a fresh process: supported
- workspace edits inside declared writable roots: supported
- normalized final assistant candidate content: supported
- interrupt by process termination: supported
- native JSON event capture: supported inside the adapter
- live native token streaming into product Items: not supported
- native approval or extension UI round trips: not supported
- native steer and follow-up: not supported by the current OpenKit contract
- multi-turn RPC operation: not supported by this adapter contract
- built-in MCP: not required and not advertised

## Tests

Required adapter tests cover:

- exact JSON-mode command construction
- five-operation `session-continuity` conformance with one fresh process per Turn and no RPC path
- first-Turn absent-path creation, exact retained-path reuse, changed-model continuation, and prior assistant context in the next native request
- ready-handle inspection of the exact nonempty session header ID and cwd before spawn; rejection of present pending paths and missing, empty, malformed, symlinked, wrong-ID, wrong-cwd, or otherwise mismatched admitted identity
- exact work-slot scoping, private handle isolation between AgentSessions, close removing control authority only, and retained JSONL bytes remaining unchanged
- exact admitted inference endpoint, adapter-owned Provider alias and logical model; rejection of mixed/direct routes; `--offline` and absence of `--api-key` or a shared config-artifact envelope
- descriptor parameters derived from the admitted model, environment-variable credential reference without credential bytes, and rejection of missing or conflicting inputs before spawn
- fresh configuration on a new attempt, preparation write failure, and cleanup after process termination on success, failure and interruption
- final settled assistant extraction and ordered text parts from one pinned success fixture
- fail-closed retry-intermediate, missing-settlement, contradictory-correlation, provider/model mismatch, error, abort, and interruption cases in one compact table
- unknown event tolerance
- malformed JSON, missing final output, and byte-bound failures
- non-zero exit and redacted diagnostics
- exact fail-closed resource, approval, session, provider, model, update, and telemetry controls
- ephemeral `PI_CODING_AGENT_DIR` isolation proving retained prompts, settings, models, packages and stale auth cannot become active authority; close preserves all retained opaque bytes
- collection or observation-flush failure returning no reusable authority and preserving native bytes for failed-closeout cleanup
- conformance with the shared `session-continuity` adapter contract already used by Codex without importing Codex-specific provenance, MCP, catalog or final-message machinery

Shared harness tests cover process-group interruption uniformly for Codex, OpenCode, and Pi.

Required image smoke covers pinned `pi --version`, JSON mode help including exact `--session` support, generic shim entrypoint, non-root user, the fixed fail-closed flags and environment, the generated Provider/logical-model projection without upstream credentials, and adapter dry run. A real Pi Task must execute verifiable repository tools, produce a reviewable change through the existing review/apply path, and expose consistent terminal results in Web and the public Skill before the route is claimed usable.

## Implementation Evidence And Limit

The current Pi `0.85.1` implementation uses the existing five-operation `session-continuity` interface. It allocates a unique absent JSONL path for each AgentSession binding, launches every Turn in a fresh process with that exact path, proves the nonempty native header ID and cwd before reuse, keeps the model descriptor Turn-private, preserves failed native bytes, removes only disposable control at close, and rejects mismatched admitted identity without an inode tracker. Its static registry entry, authored manifest, pinned worker image, adapter tests, and image smoke implement the controlled descriptor route. Complete live Task and review/apply acceptance remains outstanding, and the repository manifest remains disabled pending that proof. The 2026-07-21 arm64 image build and complete smoke, and the earlier minimal arm64 OpenShell `0.0.80` create, upload, generic-shim dry-run, and delete on A1, are historical evidence for the previous Pi `0.80.7` image contents. They are not 0.85.1 image evidence and prove neither the target NanoHost lifecycle nor RelayStream plus nested HTTP/2 feasibility. On 2026-09-05 this worktree built and smoked unique local tag `openkit/worker-pi:codex-pi-refresh-20260905` on Docker Engine 29.5.2 linux/aarch64 (image id `sha256:ba074c6f0caa0a52b9f3fd9ca0c87e6703f842f98966e0e506e1a8ad86a7b745`, smoke exit 0, native version `0.85.0`). That 0.85.0 unique-tag proof is historical for the previous pin. On 2026-09-06 this worktree built and smoked unique local tag `openkit/worker-pi:pi-0.85.1-refresh-20260906` on Docker Engine 29.5.2 linux/arm64 (image id `sha256:6cd46bcc208092417082152cf022a1818674f21bdcc921b02d6424c8e60662de`, smoke exit 0, native version `0.85.1`). That local unique-tag proof does not replace stock OpenShell, amd64 cross-build, real-provider, worker-control, heartbeat, interruption, reconnect, or recovery gates.

On 2026-09-29, an isolated native probe against pinned Pi `0.85.1` passed two separate processes using the same exact session JSONL. The second request contained the first assistant response, retained the original Pi session ID, and honored a changed admitted model. This proves the required native process-replacement capability, but it does not prove the worker adapter, shared Harness lifecycle, image, NanoHost route, or live Task acceptance. Pinned upstream source also shows that a missing or empty explicit session path is silently initialized, which is why pending launch requires absence and ready launch requires exact nonempty header proof.

After implementation on 2026-09-29, the built Pi adapter passed an isolated two-Turn native probe inside local image `openkit/worker-pi:pi-0.85.1-refresh-20260906`, whose native binary reports `0.85.1`. The adapter opened one pending binding, produced both launch plans, ran two separate Pi processes against one exact JSONL, established and retained one handle digest and native session ID, carried the first assistant response into the second inference request, honored a changed model, preserved exact JSONL bytes after close, and selected a different absent path for a successor binding on the same retained state root. The probe used a synthetic loopback inference server and direct adapter operations; it does not prove the shared native process runner, live Gateway, NanoHost route, or Task acceptance.

This local unique-tag smoke proves image contents and adapter dry-run for the current pin. It does not prove a real-provider turn, worker-control readiness, heartbeat, interruption, reconnect, or recovery lifecycle; those remain acceptance obligations of their owning specifications and change packages.

On 2026-09-06, the final Worker source `6bf9bfbc01eb4d8903dc71a45fb51e63646f5fb6` passed the catalog image build and smoke on both `linux/amd64` and `linux/arm64`. Its Pi leaf also passed stock OpenShell `0.0.99` create, AEP upload, generic-shim dry-run, and delete on A2. These observations close image-content checks for Pi `0.85.1`; Pi remains disabled for the target NanoHost route, with live-provider, adapter-lifecycle, `inference.local`, and end-to-end acceptance obligations unchanged.

Historical consumed-surface dispositions at the 2026-09-06 pin refresh: JSON-mode flags, `claude-sonnet-4-5`, `agent_settled`, and published bin `dist/bundle/cli.js` are unchanged from `0.85.0` (`compatible`); `inference.local` / `models.json` / Gateway relay were unavailable at that refresh (`blocking` then, unchanged from `0.80.7`). The 2026-09-29 approved controlled descriptor above supersedes that route limitation; live acceptance evidence remains separate from this historical pin observation. The 0.85.1 upstream delta (GPT-6 Astra, TUI/mouse/keybinding fixes, unpublished experimental client/plugin dist, GPT-5.6+ prompt-cache option) does not touch the consumed Worker contract.

## Acceptance

This adapter is clean only when deleting it and its image removes all Pi command, JSON, and resource-isolation knowledge without changing NanoCore, the shared harness contract, or canonical worker schemas.

Pi proves the intended extensibility only when it is added as one AgentManifest, one adapter module plus its static registry entry, and one image definition plus its existing-catalog entry rather than as a new NanoCore runtime path.

## Upstream Evidence

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
