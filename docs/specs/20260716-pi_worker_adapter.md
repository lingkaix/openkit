# Pi Worker Adapter

Status: Accepted
Implementation: Implemented

## Summary

The Pi Worker Adapter translates one resolved Agent Environment Package into one bounded Pi Coding Agent process and translates Pi's machine-readable native event stream into the shared OpenKit worker harness result.

Pi is the third concrete runtime challenge. Its purpose in this architecture is to prove that the worker boundary is not an accidental Codex/OpenCode common denominator.

## Owns

- Pi command construction for one bounded worker turn
- bounded parsing of Pi JSON events
- final assistant content extraction from Pi-native message records
- Pi-specific version, event compatibility, and failure tests
- Pi-specific failure mapping and conformance evidence for manifest-declared capabilities

## Does Not Own

- child process supervision, direct worker-control, canonical transcripts, or workspace publication
- AEP resolution, provider selection, credential grants, network policy, or backend lifecycle
- product state, scheduling, review, apply, Action Center, or public API behavior
- a generic RPC client or interactive terminal UI
- a translation of every Pi extension or UI event into OpenKit product events

## Upstream Contract

The accepted upstream research pin is Pi monorepo commit `818d67457cdd6b60bce6b121d16b23141c252dd8`, whose coding-agent package reports version `0.80.7`.

The current bounded native command uses JSON mode with all ambient resource and approval paths disabled:

```text
pi --mode json --no-approve --no-session --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --offline --provider <provider> --model <model> <turn-input>
```

The safe child environment sets `PI_CODING_AGENT_DIR` to a fresh AEP-controlled turn root plus `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`, and the one manifest-declared standard provider credential environment variable. The adapter spawns the argv directly without a shell and never uses `--api-key`.

Pi also provides newline-delimited JSON RPC mode with native commands including prompt, steer, follow-up, abort, session operations, and extension UI request and response. OpenKit does not adopt RPC mode in this change because the accepted product envelope is one bounded worker turn and only interrupt has a current shared control mapping.

Pi's native Skill and MCP execution remain disabled in this change. Their existence does not change OpenKit's supply or capability boundary.

## AEP Inputs Consumed

The shared harness supplies the adapter with:

- adapter id
- turn input
- worker working directory
- session directory
- the provider, model, endpoint, and credential bindings from the AEP's one already resolved LLM route
- a safe child environment without the worker-control token

The adapter does not choose provider credentials, trust arbitrary project resources, enable network sources, or override AEP policy.

## Launch Plan

`prepare` returns the exact native launch command, the safe Pi environment above, and a request for bounded exact stdout capture. The plan has no config-artifact field.

The fixed fail-closed flags prevent the image from silently loading project extensions, Skills, prompt templates, themes, context files, or saved sessions. `--no-approve` bypasses project-trust approval for the already governed workspace; it is not a general approval-state control. The fresh `PI_CODING_AGENT_DIR` prevents global `SYSTEM.md`, `APPEND_SYSTEM.md`, settings, packages, auth, and other home-directory resources from entering the run.

No environment variable, AEP extension, test option, or image diagnostic may replace the adapter-produced argv. Tests inject a process runner or a static test adapter without creating a production command override, and NanoCore never constructs a Pi command.

The adapter contract has no separate interrupt operation. The shared harness owns process-group termination.

## Native Output Mapping

`collect` parses Pi stdout as newline-delimited JSON under the shared 16 MiB native-output bound. Exceeding the bound fails collection closed.

It extracts final assistant content only after the pinned Pi stream reaches exactly one final `agent_settled` following normal zero-status exit without interruption. Within the final low-level run before that settlement, the accepted candidate is the last `message_end.message` whose `role` is `assistant` and whose `stopReason` is `stop`; a later `turn_end.message` and the last assistant message in a later `agent_end` with `willRetry=false` must each be structurally identical to that complete message. The final correlated message's provider and model must also equal the exact provider and model requested by the launch plan; missing or mismatched values fail closed instead of accepting Pi's fuzzy or synthetic model resolution. The adapter preserves only `content` entries with `type="text"` in array order, concatenates their strings without inserting separators, trims the combined boundary once, and requires a non-empty result. `error`, `aborted`, `length`, or terminal `toolUse`, `agent_end` with `willRetry=true` and no later completed run, missing or multiple settlement records, missing or contradictory correlation, malformed known records, and non-zero or signaled native exit fail collection closed. Unknown event types remain ignored for forward tolerance and cannot satisfy any required lifecycle predicate.

Pi-native tool events, extension UI events, model messages, session state, and RPC envelopes remain inside the adapter. They do not enter `packages/worker-protocol` or NanoCore.

The adapter returns a normalized final assistant message and adapter-local diagnostics. The shared harness writes schema-conformant candidate records, NanoCore alone validates and commits canonical product state, and the harness retains at most a 16 KiB prefix from each of stdout and stderr for failure diagnostics before redaction.

## Control Mapping

- current `interrupt` terminates the supervised Pi process group through the shared harness
- Pi RPC `abort` is semantically compatible with interrupt but is not required by the current JSON-mode path
- Pi RPC `steer` and `follow_up` are not advertised because OpenKit has not accepted corresponding active-turn controls
- Pi extension UI requests and responses are not mapped to approvals or questions until an explicit OpenKit product contract is accepted and tested

The Pi adapter implements only `prepare` and `collect`; it does not implement an adapter-local interrupt or RPC operation.

If a future requirement adopts RPC mode, it must reuse the same adapter boundary and shared worker-control protocol. It must not introduce Pi RPC into NanoCore.

## Skills, Extensions, And MCP

Native Skills and extensions remain disabled by the fixed launch flags. This change does not activate callable MCP or worker-capability execution, and the adapter must not scan arbitrary locations, install packages, or enable undeclared resources.

Pi does not need native MCP support to satisfy the OpenKit boundary. The OpenKit worker capability plane remains disabled; any future governed MCP work requires its owning implementation slice, and the adapter must not add a direct policy-bypassing path.

## Provider And Credentials

The authored AgentManifest owns provider, model, credential, backend-capability, and network requirements; the resolved AEP owns the exact selected route, credential binding, and effective launch policy. Pi `0.80.7` cannot consume the trusted NanoCore relay under the accepted no-generated-file adapter contract. The pinned runtime has no safe custom-base argv or environment binding; its custom-provider path requires `models.json`. Trusted relay is therefore unsupported and deferred. The adapter must not generate `models.json`, use `--api-key`, patch or fork Pi, or silently replace the relay with a direct route.

`prepare` accepts only the pinned `anthropic` / `claude-sonnet-4-5` direct pair with the manifest-declared `ANTHROPIC_API_KEY` credential binding, which the image smoke proves exists exactly in Pi's catalog. It passes that exact pair through `--provider` and `--model`, rejects zero or multiple routes, and fails before spawn when the pair or credential binding differs. Pi's fuzzy and synthetic model fallback is never accepted as route resolution. Trusted-relay and direct-provider credentials and egress remain mutually exclusive.

## Manifest And Image Contract

The repository-owned Pi AgentManifest selects adapter id `pi`, the Pi worker image, native executable paths used by network policy, the exact `anthropic` / `claude-sonnet-4-5` pair and `ANTHROPIC_API_KEY` binding, resource-discovery isolation flags, and only capabilities proven by this specification.

The Pi image installs the generic worker shim and `@earendil-works/pi-coding-agent@0.80.7`, sets the generic shim as its entrypoint, runs as a non-root worker user, and contains no Codex or OpenCode runtime. Its smoke check verifies the exact native version, JSON mode, generic shim dry run, the fixed fail-closed flags and environment, every provider/model pair advertised by the Pi manifest as an exact pinned-catalog pair, non-root identity, and expected worker filesystem layout.

Pi-specific install commands, binary paths, resource flags, event fixtures, and version pins live only in the Pi AgentManifest, adapter, image, specification, and tests.

## Failure Semantics

- malformed or over-limit native JSON output fails adapter collection closed
- missing trustworthy final assistant content fails collection when the native run claims success
- a non-zero native exit returns a failed adapter classification with bounded, redacted diagnostics
- interruption wins over partial assistant content
- worker-control failure stops Pi through the shared harness
- undeclared resource or extension loading is an image/manifest policy failure, not a reason to broaden the adapter
- the harness deletes the turn-scoped Pi agent root after collection and retains no native session state

## Capability Declaration

The authored manifest is the sole launch-time capability declaration. Adapter conformance and image smoke prove that the manifest advertises only the following supported behavior; `prepare` does not return a second capability declaration:

- bounded turn execution: supported
- workspace edits inside declared writable roots: supported
- normalized final assistant candidate content: supported
- interrupt by process termination: supported
- native JSON event capture: supported inside the adapter
- live native token streaming into product Items: not supported
- native approval or extension UI round trips: not supported
- native steer and follow-up: not supported by the current OpenKit contract
- multi-turn RPC session resume: not supported by this adapter contract
- built-in MCP: not required and not advertised

## Tests

Required adapter tests cover:

- exact JSON-mode command construction
- trusted-relay rejection, exact pinned provider/model enforcement, `--offline`, and absence of `--api-key` or config artifacts
- final settled assistant extraction and ordered text parts from one pinned success fixture
- fail-closed retry-intermediate, missing-settlement, contradictory-correlation, provider/model mismatch, error, abort, and interruption cases in one compact table
- unknown event tolerance
- malformed JSON, missing final output, and byte-bound failures
- non-zero exit and redacted diagnostics
- exact fail-closed resource, approval, session, provider, model, update, and telemetry controls
- turn-scoped `PI_CODING_AGENT_DIR` isolation proving global prompts, settings, packages, and auth cannot load
- conformance with the same shared adapter contract used by Codex and OpenCode

Shared harness tests cover process-group interruption uniformly for Codex, OpenCode, and Pi.

Required image smoke covers pinned `pi --version`, JSON mode help, generic shim entrypoint, non-root user, the fixed fail-closed flags and environment, exact manifest-advertised provider/model catalog pairs, and adapter dry run.

## Implementation Evidence And Limit

The Pi `0.80.7` adapter, static registry entry, authored manifest, pinned worker image, bounded `prepare`/`collect` tests, and image smoke are implemented for the exact direct `anthropic` / `claude-sonnet-4-5` route. On A1, the arm64 image was built directly, passed its smoke check, and stock unpatched OpenShell `0.0.80` created a sandbox from it, uploaded the AEP package, completed the generic shim dry run, and deleted the sandbox after the Cell's separate same-tag image cache was refreshed.

This dry run proves image contents, adapter preparation, stock OpenShell containment, upload, and cleanup. It does not prove a real-provider turn, worker-control readiness, heartbeat, interruption, reconnect, or recovery lifecycle; those remain acceptance obligations of their owning specifications and change packages.

## Acceptance

This adapter is clean only when deleting it and its image removes all Pi command, JSON, and resource-isolation knowledge without changing NanoCore, the shared harness contract, or canonical worker schemas.

Pi proves the intended extensibility only when it is added as one AgentManifest, one adapter module plus its static registry entry, and one image definition plus its existing-catalog entry rather than as a new NanoCore runtime path.

## Upstream Evidence

- `https://github.com/badlogic/pi-mono/blob/818d67457cdd6b60bce6b121d16b23141c252dd8/packages/coding-agent/README.md`
- `https://github.com/badlogic/pi-mono/blob/818d67457cdd6b60bce6b121d16b23141c252dd8/packages/coding-agent/docs/json.md`
- `https://github.com/badlogic/pi-mono/blob/818d67457cdd6b60bce6b121d16b23141c252dd8/packages/coding-agent/docs/rpc.md`
- `https://github.com/badlogic/pi-mono/blob/818d67457cdd6b60bce6b121d16b23141c252dd8/packages/ai/src/types.ts`
- `https://github.com/badlogic/pi-mono/blob/818d67457cdd6b60bce6b121d16b23141c252dd8/packages/agent/src/types.ts`
- `https://github.com/badlogic/pi-mono/blob/818d67457cdd6b60bce6b121d16b23141c252dd8/packages/agent/src/agent-loop.ts`
- `https://github.com/badlogic/pi-mono/blob/818d67457cdd6b60bce6b121d16b23141c252dd8/packages/coding-agent/src/core/agent-session.ts`
- `https://github.com/badlogic/pi-mono/blob/818d67457cdd6b60bce6b121d16b23141c252dd8/packages/coding-agent/src/modes/print-mode.ts`
- `https://github.com/badlogic/pi-mono/blob/818d67457cdd6b60bce6b121d16b23141c252dd8/packages/coding-agent/test/suite/agent-session-retry-events.test.ts`
- `https://github.com/badlogic/pi-mono/blob/818d67457cdd6b60bce6b121d16b23141c252dd8/packages/coding-agent/test/suite/regressions/6363-agent-settled-event.test.ts`

## Related Documents

- `docs/changes/202607160036500001-worker_agent_adapter_boundary.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-worker_control_protocol.md`
