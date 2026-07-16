# Codex Worker Adapter

Status: Accepted
Implementation: Not Started

## Summary

The Codex Worker Adapter translates one resolved Agent Environment Package into one bounded `codex exec` process and translates Codex-native output and optional rollout evidence into the shared OpenKit worker harness result.

The adapter is worker-side integration code. It is not a NanoCore runtime, transport, policy engine, product model, or provider owner.

## Owns

- Codex command construction for one bounded worker turn
- Codex final assistant message collection
- Codex JSONL stdout forwarding into optional native provenance capture
- Codex state-root discovery required by the accepted provenance contract
- Codex-specific version and native event compatibility tests
- truthful Codex adapter capabilities and failure diagnostics

## Does Not Own

- child process supervision or process-group cleanup
- worker-control readiness, heartbeat, polling, sequencing, or authentication
- canonical transcript persistence or NanoCore event import
- AEP resolution, provider selection, credential grants, or network authorization
- workspace snapshot, review, apply, or durable product state
- Goal Mode, Action Center, scheduling, placement, or backend lifecycle

## Upstream Contract

The accepted implementation pin is Codex CLI `0.144.1`, matching the real worker image and runtime-provenance fixtures.

The bounded native command is equivalent to:

```text
codex exec --json --output-last-message <session-final-message-path> --cd <workspace> --dangerously-bypass-approvals-and-sandbox <turn-input>
```

The approval and sandbox bypass flag is permitted only because OpenKit already places the process inside a governed, least-privilege worker container and NanoCore owns filesystem, network, credential, review, and external-side-effect policy. It must never be used to create a host runtime path.

## AEP Inputs Consumed

The shared harness supplies the adapter with:

- adapter id
- turn input
- worker working directory
- session directory and final-message path
- provider and model settings already resolved into worker-local environment or generated config
- optional native provenance declaration
- a safe child environment that excludes the worker-control credential

The adapter must not read NanoCore private storage or invent missing provider, model, policy, or credential decisions.

## Launch Plan

The adapter returns a native launch plan containing command argv, safe child environment additions, whether exact stdout capture is required, and the final assistant extraction strategy.

An explicit adapter-local command override may exist for tests and image diagnostics. NanoCore must not construct or override a Codex command.

## Native Output Mapping

Codex writes the final assistant response to the bounded `--output-last-message` file. The adapter validates that the path is a regular file, applies the shared 16 MiB bound, decodes UTF-8, trims surrounding whitespace, and returns either one assistant message or no message.

Codex JSONL stdout is not imported directly into NanoCore product state. When runtime provenance is enabled, exact stdout bytes are passed to the Codex provenance capture implementation and finalized only after a successful shared harness lifecycle.

Malformed native events may invalidate provenance evidence, but they must not bypass canonical terminal outcome creation or cause NanoCore to accept native Codex schemas.

## Control Mapping

The currently implemented OpenKit worker envelope is one bounded turn.

- `interrupt` terminates the supervised Codex process group through the shared harness.
- `terminal-command` remains a shared, narrowly allowlisted worker-control operation and is not implemented by the Codex adapter.
- native approval requests, questions, steering, and session continuation are not advertised by this adapter in the bounded path.

## Skills And MCP

NanoCore resolves approved Skill and MCP supply into the AEP. The shared harness materializes those declared files. The Codex adapter may map resolved locations into Codex-native configuration, but it must not discover, install, authorize, or broaden supply.

## Provider And Credentials

Provider selection, trusted inference, OAuth account choice, credential declarations, vault grants, and network rules are NanoCore-owned profile and AEP decisions.

The adapter consumes already materialized Codex configuration and safe environment values. Codex-specific auth file placement is profile data, not a generic AEP resolver special case.

## Profile And Image Contract

The repository-owned Codex profile selects adapter id `codex`, the Codex worker image, pinned runtime version `0.144.1`, native executable paths used by network policy, trusted-inference or explicit credential requirements, and only capabilities proven by this specification.

The Codex image installs the generic worker shim and Codex `0.144.1`, sets the generic shim as its entrypoint, runs as a non-root worker user, and contains no OpenCode or Pi runtime. Its smoke check verifies the exact native version, `codex exec` machine-readable flags, generic shim dry run, non-root identity, and expected worker filesystem layout.

Codex-specific install commands, binary paths, state directories, auth paths, and version pins live only in the Codex profile, adapter, image, specification, and tests.

## Provenance

Codex runtime provenance is optional and governed by `docs/specs/20260711-worker_runtime_subagent_provenance.md`.

The Codex adapter owns the hook that captures pinned native rollout streams and projects their index and manifest into the shared session evidence directory. The shared harness owns lifecycle timing and failure cleanup; NanoCore owns evidence verification and import.

No other adapter is required to imitate Codex rollout files.

## Failure Semantics

- missing or invalid final-message files fail the adapter collection step when the path exists but violates file or size constraints
- a non-zero native exit produces a failed shared terminal outcome with bounded, redacted stdout and stderr summaries
- process interruption produces `interrupted` regardless of a partial final-message file
- provenance capture failure invalidates provenance evidence and fails according to the accepted provenance contract
- worker-control failure remains a shared harness failure and stops Codex

## Capability Declaration

The bounded Codex adapter declares:

- bounded turn execution: supported
- workspace edits inside declared writable roots: supported
- canonical final assistant message: supported
- interrupt by process termination: supported
- live native token streaming into product Items: not supported
- native approval or question round trips: not supported
- multi-turn native session resume: not supported by this adapter contract
- optional runtime provenance: supported only by the pinned image and accepted AEP feature

## Tests

Required adapter tests cover:

- exact command construction from an adapter input
- command override isolation inside the adapter
- final-message success, absence, non-file, and size-bound behavior
- non-zero exit and redacted failure diagnostics
- interrupt mapping through shared process supervision
- exact stdout forwarding when provenance is enabled
- conformance with the shared adapter contract
- rejection of unsupported interactive capabilities

Required image smoke covers the pinned `codex --version`, machine-readable `codex exec` help, generic shim entrypoint, non-root user, and adapter dry run.

## Acceptance

This adapter is clean only when deleting it and its image removes all Codex-native command, output, and provenance knowledge without changing the shared worker contract or NanoCore product and governance core.

## Related Documents

- `docs/changes/202607160036500001-worker_agent_adapter_boundary.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
