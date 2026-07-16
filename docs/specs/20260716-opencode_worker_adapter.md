# OpenCode Worker Adapter

Status: Accepted
Implementation: Not Started

## Summary

The OpenCode Worker Adapter translates one resolved Agent Environment Package into one bounded OpenCode process and translates its machine-readable native event stream into the shared OpenKit worker harness result.

The current product path uses OpenCode's one-shot run surface. The OpenCode HTTP server is not a second OpenKit control plane and is not required for one bounded worker turn.

## Owns

- OpenCode command construction for one bounded worker turn
- bounded parsing of OpenCode JSON output
- final assistant text extraction from OpenCode-native records
- optional native session identifier capture as evidence
- OpenCode-specific version, event compatibility, and failure tests
- truthful OpenCode adapter capabilities

## Does Not Own

- OpenCode server lifecycle inside NanoCore
- child process supervision, worker-control, canonical transcript writing, or workspace publication
- AEP resolution, provider selection, credential grants, network policy, or backend lifecycle
- product state, scheduling, review, apply, Action Center, or public API behavior
- a translation of every OpenCode native event into the canonical worker protocol

## Upstream Contract

The accepted implementation pin is official OpenCode `v1.18.1`, commit `99f638d8293f6985726ba509da602296c4963497`, installed as `opencode-ai@1.18.1`.

The bounded native command uses the pinned OpenCode CLI machine-readable run surface:

```text
opencode run --format json --dir <workspace> --model <provider/model> --title "" <turn-input>
```

The adapter spawns argv directly without a shell and never passes `--auto`. The pinned non-interactive path denies native question and plan-transition permissions and rejects other permission requests, which matches the current fail-closed bounded Worker contract rather than fabricating live approval support.

The native `opencode serve` HTTP surface is reserved for a future accepted interactive-session requirement. It must not be introduced only to imitate an OpenKit control gateway or to expose OpenCode-native HTTP routes to NanoCore.

## AEP Inputs Consumed

The shared harness supplies the adapter with:

- adapter id
- turn input
- worker working directory
- session directory
- provider and model settings already materialized into worker-local configuration
- a safe child environment without the worker-control token

The adapter does not resolve providers, credentials, models, permissions, Skills, MCP authorization, or workspace policy.

## Launch Plan

The adapter returns one native launch command and requests bounded exact stdout capture because final output is encoded in the JSON event stream.

An adapter-local command override may be used by tests and image diagnostics. NanoCore must not know OpenCode flags or construct an OpenCode command.

## Native Output Mapping

The adapter parses stdout as newline-delimited JSON under the shared native-output byte bound.

It ignores unknown event types for forward tolerance, rejects malformed JSON records that prevent a trustworthy final result, and handles the pinned `step_start`, `text`, `step_finish`, and `error` records.

The adapter tracks the latest `step_start.part.messageID`, collects subsequent completed and non-ignored `text` parts with the same message id, preserves stream order, and joins non-empty part text with a blank line. Success requires exit code zero, no native `error` record, and a terminal `step_finish` for the tracked assistant message.

Native OpenCode event names, tool-call records, provider payloads, and session objects remain inside the adapter and optional raw evidence. They are not added to `packages/worker-protocol` and do not enter NanoCore.

The adapter returns a normalized final assistant message, optional product-safe native session metadata, and adapter-local diagnostics. The shared harness writes the canonical assistant Item and terminal outcome.

## Control Mapping

- `interrupt` terminates the supervised OpenCode process group through the shared harness.
- `terminal-command` is shared harness behavior, not OpenCode behavior.
- OpenCode session continuation is not advertised in the bounded adapter.
- OpenCode server abort, permission, question, and event subscription APIs are not exposed until OpenKit accepts and tests a corresponding product control contract.

## Skills And MCP

OpenCode-native Skill and MCP configuration is generated only from NanoCore-resolved AEP supply. The adapter may translate approved paths and endpoints into OpenCode configuration, but it must not install, discover, authorize, or broaden supply.

## Provider And Credentials

Provider and model selection belongs to the Worker Agent profile and AEP. Credential values are materialized through the governed backend and vault declarations. The adapter consumes the resulting worker-local configuration and does not introduce OpenCode provider defaults into NanoCore.

The governed profile disables ambient OpenCode configuration and downloads with `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`, `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, and `OPENCODE_DISABLE_LSP_DOWNLOAD=1`. Approved capabilities are added back only through AEP supply.

## Profile And Image Contract

The repository-owned OpenCode profile selects adapter id `opencode`, the OpenCode worker image, native executable paths used by network policy, provider and credential requirements, the configuration-isolation variables above, and only capabilities proven by this specification.

The OpenCode image installs the generic worker shim and `opencode-ai@1.18.1`, sets the generic shim as its entrypoint, runs as a non-root worker user, and contains no Codex or Pi runtime. Its smoke check verifies the exact native version, JSON run mode, generic shim dry run, ambient configuration isolation, non-root identity, and expected worker filesystem layout.

OpenCode-specific install commands, binary paths, environment isolation, event fixtures, and version pins live only in the OpenCode profile, adapter, image, specification, and tests.

## Failure Semantics

- malformed or over-limit native output fails adapter collection closed
- a zero exit without a trustworthy final assistant result may complete with no assistant Item only when the pinned native contract permits that outcome; otherwise it fails collection
- a non-zero native exit produces a failed shared terminal outcome with bounded, redacted diagnostics
- interruption wins over any partial final assistant content
- worker-control failure stops the OpenCode process through the shared harness

## Capability Declaration

The bounded OpenCode adapter declares:

- bounded turn execution: supported
- workspace edits inside declared writable roots: supported
- canonical final assistant message: supported
- interrupt by process termination: supported
- live native token streaming into product Items: not supported
- native approval or question round trips: not supported
- OpenCode HTTP server exposure: not supported
- multi-turn native session resume: not supported by this adapter contract

## Tests

Required adapter tests cover:

- exact command construction from adapter input
- final assistant extraction from pinned native JSON fixtures
- unknown event tolerance
- malformed JSON, missing final output, and byte-bound failures
- non-zero exit and redacted diagnostics
- interrupt mapping through shared process supervision
- optional session metadata capture without native schema leakage
- conformance with the same shared adapter contract used by Codex and Pi

Required image smoke covers the pinned `opencode --version`, JSON run mode help, generic shim entrypoint, non-root user, and adapter dry run.

## Acceptance

This adapter is clean only when deleting it and its image removes all OpenCode command, event, and session knowledge without changing NanoCore, the shared harness contract, or canonical worker schemas.

## Upstream Evidence

- `https://github.com/anomalyco/opencode/commit/99f638d8293f6985726ba509da602296c4963497`
- `https://github.com/anomalyco/opencode/blob/99f638d8293f6985726ba509da602296c4963497/packages/web/src/content/docs/index.mdx`
- `https://github.com/anomalyco/opencode/blob/99f638d8293f6985726ba509da602296c4963497/packages/opencode/src/cli/cmd/run.ts`
- `https://github.com/anomalyco/opencode/blob/99f638d8293f6985726ba509da602296c4963497/packages/web/src/content/docs/server.mdx`

## Related Documents

- `docs/changes/202607160036500001-worker_agent_adapter_boundary.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-worker_control_protocol.md`
