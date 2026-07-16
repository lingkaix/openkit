# Pi Worker Adapter

Status: Accepted
Implementation: Not Started

## Summary

The Pi Worker Adapter translates one resolved Agent Environment Package into one bounded Pi Coding Agent process and translates Pi's machine-readable native event stream into the shared OpenKit worker harness result.

Pi is the third concrete runtime challenge. Its purpose in this architecture is to prove that the worker boundary is not an accidental Codex/OpenCode common denominator.

## Owns

- Pi command construction for one bounded worker turn
- bounded parsing of Pi JSON events
- final assistant content extraction from Pi-native message records
- optional native session metadata capture as evidence
- Pi-specific version, event compatibility, and failure tests
- truthful Pi adapter capabilities

## Does Not Own

- child process supervision, direct worker-control, canonical transcripts, or workspace publication
- AEP resolution, provider selection, credential grants, network policy, or backend lifecycle
- product state, scheduling, review, apply, Action Center, or public API behavior
- a generic RPC client or interactive terminal UI
- a translation of every Pi extension or UI event into OpenKit product events

## Upstream Contract

The accepted upstream research pin is Pi monorepo commit `818d67457cdd6b60bce6b121d16b23141c252dd8`, whose coding-agent package reports version `0.80.7`.

The current bounded native command uses JSON mode:

```text
pi --mode json <turn-input>
```

Pi also provides newline-delimited JSON RPC mode with native commands including prompt, steer, follow-up, abort, session operations, and extension UI request and response. OpenKit does not adopt RPC mode in this change because the accepted product envelope is one bounded worker turn and only interrupt has a current shared control mapping.

Pi's native Skills support may consume AEP-approved Skill supply. Pi has no built-in MCP ownership that changes OpenKit's supply or capability boundary.

## AEP Inputs Consumed

The shared harness supplies the adapter with:

- adapter id
- turn input
- worker working directory
- session directory
- provider and model settings already materialized into worker-local configuration
- a safe child environment without the worker-control token

The adapter does not choose provider credentials, trust arbitrary project resources, enable network sources, or override AEP policy.

## Launch Plan

The adapter returns one native launch command in JSON mode and requests bounded exact stdout capture.

The production profile must explicitly control Pi resource discovery and trust behavior so the image cannot silently load undeclared project resources, extensions, prompt templates, or Skills. Native resource flags belong to the profile or generated worker-local configuration, not NanoCore branches.

An adapter-local command override may be used by tests and image diagnostics. NanoCore must not know Pi flags or construct a Pi command.

## Native Output Mapping

The adapter parses Pi stdout as newline-delimited JSON under the shared native-output byte bound.

It extracts final assistant content from the pinned Pi message completion shape, preserves text-part ordering, ignores unknown event types for forward tolerance, and rejects malformed records that make the final result untrustworthy.

Pi-native tool events, extension UI events, model messages, session state, and RPC envelopes remain inside the adapter or optional raw evidence. They do not enter `packages/worker-protocol` or NanoCore.

The adapter returns a normalized final assistant message, optional product-safe native session metadata, and adapter-local diagnostics. The shared harness writes the canonical assistant Item and terminal outcome.

## Control Mapping

- current `interrupt` terminates the supervised Pi process group through the shared harness
- `terminal-command` remains shared harness behavior
- Pi RPC `abort` is semantically compatible with interrupt but is not required by the current JSON-mode path
- Pi RPC `steer` and `follow_up` are not advertised because OpenKit has not accepted corresponding active-turn controls
- Pi extension UI requests and responses are not mapped to approvals or questions until an explicit OpenKit product contract is accepted and tested

If a future requirement adopts RPC mode, it must reuse the same adapter boundary and shared worker-control protocol. It must not introduce Pi RPC into NanoCore.

## Skills, Extensions, And MCP

Pi-native Skills and extensions are materialized only from NanoCore-resolved, digest-pinned AEP supply. The adapter may translate approved paths into Pi resource flags, but it must not scan arbitrary locations, install packages, or enable undeclared resources.

Pi does not need native MCP support to satisfy the OpenKit boundary. Future governed MCP calls use the accepted OpenKit worker capability plane after that plane is implemented; the adapter must not add a direct policy-bypassing MCP path.

## Provider And Credentials

Provider and model selection belongs to the Worker Agent profile and AEP. Pi receives already materialized provider configuration or the trusted OpenAI-compatible inference route. The adapter must not add Pi provider defaults or API key handling to NanoCore.

## Profile And Image Contract

The repository-owned Pi profile selects adapter id `pi`, the Pi worker image, native executable paths used by network policy, provider and credential requirements, resource-discovery isolation flags, and only capabilities proven by this specification.

The Pi image installs the generic worker shim and `@earendil-works/pi-coding-agent@0.80.7`, sets the generic shim as its entrypoint, runs as a non-root worker user, and contains no Codex or OpenCode runtime. Its smoke check verifies the exact native version, JSON and RPC mode discovery, generic shim dry run, disabled ambient extensions and resources, non-root identity, and expected worker filesystem layout.

Pi-specific install commands, binary paths, resource flags, event fixtures, and version pins live only in the Pi profile, adapter, image, specification, and tests.

## Failure Semantics

- malformed or over-limit native JSON output fails adapter collection closed
- missing trustworthy final assistant content fails collection when the native run claims success
- a non-zero native exit produces a failed shared terminal outcome with bounded, redacted diagnostics
- interruption wins over partial assistant content
- worker-control failure stops Pi through the shared harness
- undeclared resource or extension loading is an image/profile policy failure, not a reason to broaden the adapter

## Capability Declaration

The bounded Pi adapter declares:

- bounded turn execution: supported
- workspace edits inside declared writable roots: supported
- canonical final assistant message: supported
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
- final assistant text extraction and ordered text parts from pinned native fixtures
- unknown event tolerance
- malformed JSON, missing final output, and byte-bound failures
- non-zero exit and redacted diagnostics
- interrupt mapping through shared process supervision
- resource-discovery flags or profile controls that prevent undeclared supply loading
- conformance with the same shared adapter contract used by Codex and OpenCode

Required image smoke covers pinned `pi --version`, JSON and RPC mode help, generic shim entrypoint, non-root user, disabled undeclared resource discovery, and adapter dry run.

## Acceptance

This adapter is clean only when deleting it and its image removes all Pi command, JSON, RPC, resource, and session knowledge without changing NanoCore, the shared harness contract, or canonical worker schemas.

Pi proves the intended extensibility only when it is added as one profile, one adapter, and one image rather than as a new NanoCore runtime path.

## Upstream Evidence

- `https://github.com/badlogic/pi-mono/blob/818d67457cdd6b60bce6b121d16b23141c252dd8/packages/coding-agent/README.md`
- `https://github.com/badlogic/pi-mono/blob/818d67457cdd6b60bce6b121d16b23141c252dd8/packages/coding-agent/docs/json.md`
- `https://github.com/badlogic/pi-mono/blob/818d67457cdd6b60bce6b121d16b23141c252dd8/packages/coding-agent/docs/rpc.md`

## Related Documents

- `docs/changes/202607160036500001-worker_agent_adapter_boundary.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-worker_control_protocol.md`
