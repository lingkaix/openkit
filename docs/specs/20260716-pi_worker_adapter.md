---
status: Accepted
implementation: Partial
updated: 2026-09-05
---
# Pi Worker Adapter

## Summary

The Pi Worker Adapter translates one resolved Agent Environment Package into one bounded Pi Coding Agent process and translates Pi's machine-readable native event stream into the shared OpenKit worker harness result.

Pi is the third concrete runtime challenge. Its purpose in this architecture is to prove that the worker boundary is not an accidental Codex/OpenCode common denominator.

This adapter remains in the shared registry's `bounded-turn` mode and is already ineligible for the target NanoHost route. It is not eligible for the multi-AgentSession shared-Harness RuntimeTarget until this owning specification accepts and the pinned runtime proves both the route and complete `session-continuity` contracts; the Codex implementation does not implicitly broaden Pi.

## Owns

- Pi command construction for one bounded worker turn
- bounded parsing of Pi JSON events
- final assistant content extraction from Pi-native message records
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

The accepted upstream research pin is Pi monorepo commit `107d79f11072bbc8a3a757ed7fd69596bee7d68c`, whose coding-agent package reports version `0.85.0`.

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
- the preferred and allowed logical-model contract plus the sandbox-local `inference.local` binding when a future accepted Pi adapter can consume it
- a safe child environment without the worker-control or capability token; any target inference binding uses its own distinct inference credential

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

Pi does not need native MCP support to satisfy the OpenKit boundary. The selected MCP capability plane is implemented only for the delivered Codex session-continuity adapter; Pi remains ineligible and must not add a direct policy-bypassing path.

## Provider And Credentials

The accepted NanoHost runtime exposes the logical worker-local `inference.local` binding at fixed `http://127.0.0.1:17892/inference/v1`, projected by Sandbox Integration through `/inference/*` with an inference credential distinct from `/worker-control/*` and `/capabilities/*`. Pi must not receive a direct NanoCore endpoint, the worker-control token, an SSH or Gateway-forward route, or a second control path. The pinned Pi runtime still cannot consume that fixed target under this adapter contract, so the target remains unsupported for Pi.

The authored Agent Manifest owns logical-model preferences, credential requirements, backend-capability requirements, and network needs; the resolved AEP owns the exact allowed logical-model contract, credential bindings, and effective launch policy while the Gateway privately owns Provider routes. Pi `0.85.0` cannot consume the accepted `inference.local` target under the no-generated-file adapter contract. The pinned runtime has no safe custom-base argv or environment binding; its custom-Provider path requires `models.json`. The target binding is therefore unsupported. The adapter must not generate `models.json`, use `--api-key`, patch or fork Pi, expose a concrete Provider route, or silently replace worker-local inference with a direct route.

The historical Pi adapter accepted only the pinned `anthropic` / `claude-sonnet-4-5` direct pair with the manifest-declared `ANTHROPIC_API_KEY` credential binding, which the image smoke proved existed exactly in Pi's catalog. It passed that exact pair through `--provider` and `--model`, rejected zero or multiple routes, and failed before spawn when the pair or credential binding differed. Pi's fuzzy and synthetic model fallback was never accepted as route resolution. This direct credential path is historical evidence, not current NanoHost guidance.

## Manifest And Image Contract

The repository-owned Pi AgentManifest selects adapter id `pi`, the Pi worker image, native executable paths used by network policy, the exact `anthropic` / `claude-sonnet-4-5` pair and `ANTHROPIC_API_KEY` binding, resource-discovery isolation flags, and only capabilities proven by this specification.

The Pi image installs the generic worker shim and `@earendil-works/pi-coding-agent@0.85.0`, sets the generic shim as its entrypoint, runs as a non-root worker user, and contains no Codex or OpenCode runtime. Its current smoke check verifies the exact native version, JSON mode, generic shim dry run, the fixed fail-closed flags and environment, the historical direct Provider/model pair, non-root identity, and expected worker filesystem layout. That catalog proof does not make Pi dispatch-ready under the logical-model target.

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
- conformance with the shared `bounded-turn` adapter contract also used by OpenCode

Shared harness tests cover process-group interruption uniformly for Codex, OpenCode, and Pi.

Required image smoke covers pinned `pi --version`, JSON mode help, generic shim entrypoint, non-root user, the fixed fail-closed flags and environment, exact manifest-advertised provider/model catalog pairs, and adapter dry run.

## Implementation Evidence And Limit

The Pi `0.85.0` bounded-turn adapter, static registry entry, authored manifest, pinned worker image, bounded `prepare`/`collect` tests, and image smoke are implemented for the legacy direct `anthropic` / `claude-sonnet-4-5` route. Pi remains ineligible for the target NanoHost route and shared-Harness RuntimeTarget because neither the accepted route nor a session-continuity adapter is implemented. The 2026-07-21 arm64 image build and complete smoke, and the earlier minimal arm64 OpenShell `0.0.80` create, upload, generic-shim dry-run, and delete on A1, are historical evidence for the previous Pi `0.80.7` image contents. They are not 0.85.0 image evidence and prove neither the target NanoHost lifecycle nor RelayStream plus nested HTTP/2 feasibility. On 2026-09-05 this worktree built and smoked unique local tag `openkit/worker-pi:codex-pi-refresh-20260905` on Docker Engine 29.5.2 linux/aarch64 (image id `sha256:ba074c6f0caa0a52b9f3fd9ca0c87e6703f842f98966e0e506e1a8ad86a7b745`, smoke exit 0, native version `0.85.0`). That local unique-tag proof does not replace stock OpenShell, amd64 cross-build, real-provider, worker-control, heartbeat, interruption, reconnect, or recovery gates.

This local unique-tag smoke proves image contents and adapter dry-run for the 0.85.0 pin. It does not prove a real-provider turn, worker-control readiness, heartbeat, interruption, reconnect, or recovery lifecycle; those remain acceptance obligations of their owning specifications and change packages.

Consumed-surface dispositions for this pin change: JSON-mode flags, `claude-sonnet-4-5`, and `agent_settled` remain present (`compatible`); the published bin path moved from `dist/cli.js` to `dist/bundle/cli.js` and smoke was updated (`adapted`); `inference.local` / `models.json` / Gateway relay remain unavailable (`blocking` for the target route, unchanged from `0.80.7` and not invented by this refresh).

## Acceptance

This adapter is clean only when deleting it and its image removes all Pi command, JSON, and resource-isolation knowledge without changing NanoCore, the shared harness contract, or canonical worker schemas.

Pi proves the intended extensibility only when it is added as one AgentManifest, one adapter module plus its static registry entry, and one image definition plus its existing-catalog entry rather than as a new NanoCore runtime path.

## Upstream Evidence

- `https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/coding-agent/README.md`
- `https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/coding-agent/docs/json.md`
- `https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/coding-agent/docs/rpc.md`
- `https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/ai/src/types.ts`
- `https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/agent/src/types.ts`
- `https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/agent/src/agent-loop.ts`
- `https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/coding-agent/src/core/agent-session.ts`
- `https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/coding-agent/src/modes/print-mode.ts`
- `https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/coding-agent/test/suite/agent-session-retry-events.test.ts`
- `https://github.com/earendil-works/pi/blob/107d79f11072bbc8a3a757ed7fd69596bee7d68c/packages/coding-agent/test/suite/regressions/6363-agent-settled-event.test.ts`

## Related Documents


- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
