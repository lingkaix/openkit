# Codex Worker Adapter

Status: Accepted
Implementation: Partial

## Summary

The Codex Worker Adapter translates one resolved Agent Environment Package into one bounded `codex exec` process and translates Codex-native output and optional rollout evidence into the shared OpenKit worker harness result.

The adapter is worker-side integration code. It is not a NanoCore runtime, transport, policy engine, product model, or provider owner.

## Owns

- Codex command construction for one bounded worker turn
- Codex final assistant message collection
- Codex JSONL stdout forwarding into optional native provenance capture
- Codex state-root discovery required by the accepted provenance contract
- Codex-specific version and native event compatibility tests
- Codex-specific failure mapping and conformance evidence for manifest-declared capabilities

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
codex exec --json --ignore-user-config --ignore-rules [--ephemeral] --output-last-message <session-final-message-path> --cd <workspace> --dangerously-bypass-approvals-and-sandbox <turn-input>
```

Every invocation also uses `--ignore-user-config` and `--ignore-rules`. When S33 provenance is disabled it uses `--ephemeral`; when S33 provenance is required it omits `--ephemeral` only so the pinned rollout files can be captured from a fresh turn-scoped `CODEX_HOME`.

The approval and sandbox bypass flag is permitted only because OpenKit already places the process inside a governed, least-privilege worker container and NanoCore owns filesystem, network, credential, review, and external-side-effect policy. It must never be used to create a host runtime path.

## AEP Inputs Consumed

The shared harness supplies the adapter with:

- adapter id
- turn input
- worker working directory
- session directory and final-message path
- the provider, model, endpoint, and credential bindings from the AEP's one already resolved LLM route
- optional native provenance declaration
- a safe child environment that excludes the worker-control credential

The adapter must not read NanoCore private storage or invent missing provider, model, policy, or credential decisions.

The shared harness supplies one fresh empty session state root. `prepare` selects a turn-scoped `CODEX_HOME` beneath it but returns no config or authentication files. AEP-resolved authentication and provider material may enter the child only through the backend-materialized credential bindings and adapter-owned argv or safe environment; executable MCP server entries, hooks, memories, prior sessions, and ambient user state are absent. `--ignore-user-config` and `--ignore-rules` prevent the native runtime from treating workspace policy files as hidden execution authority.

## Launch Plan

`prepare` returns a native launch plan containing command argv, safe child environment additions, whether exact stdout capture is required, and the final assistant extraction strategy. The plan has no config-artifact field.

An explicit adapter-local command override may exist for tests and image diagnostics. NanoCore must not construct or override a Codex command.

The adapter contract has no separate interrupt or provenance operation. The shared harness owns process-group termination, while `prepare` may attach the existing Codex-local provenance sink lifecycle to the launch plan.

## Native Output Mapping

Codex writes the final assistant response to the bounded `--output-last-message` file. `collect` validates that the path is a regular file, applies the shared 16 MiB bound, decodes UTF-8, trims surrounding whitespace, and returns either one assistant message or no message.

Codex JSONL stdout is not imported directly into NanoCore product state. When runtime provenance is enabled, exact stdout bytes are passed to the Codex provenance capture implementation and finalized only after a successful shared harness lifecycle.

Outside the separately bounded streaming provenance path, native result content is limited to 16 MiB. The shared process runner retains at most a 16 KiB prefix from each of stdout and stderr for failure diagnostics before redaction.

Malformed native events may invalidate provenance evidence, but they must not bypass candidate terminal classification or cause NanoCore to accept native Codex schemas.

`collect` returns normalized assistant content or a product-safe failure classification. The shared harness emits schema-conformant candidate records, and NanoCore alone validates and commits canonical Items and terminal state.

## Control Mapping

The currently implemented OpenKit worker envelope is one bounded turn.

- `interrupt` terminates the supervised Codex process group through the shared harness.
- native approval requests, questions, steering, and session continuation are not advertised by this adapter in the bounded path.

The Codex adapter implements only `prepare` and `collect`; it does not implement an adapter-local interrupt operation.

## Skills And MCP

NanoCore may resolve approved static Skill and MCP supply into the AEP, but this change does not activate callable MCP or worker-capability execution. The capability plane remains disabled, and the Codex adapter must not discover, install, authorize, or broaden supply.

## Provider And Credentials

Provider selection, trusted inference, OAuth account choice, credential declarations, vault grants, and network rules are NanoCore-owned AgentManifest and AEP decisions.

The adapter consumes the AEP's one resolved route and its safe credential bindings and expresses Codex-native setup only through argv and safe environment additions. It rejects zero or multiple routes and never selects a provider, model, or fallback. The AgentManifest declares credential requirements and governed attachment inputs, but neither NanoCore nor the shared harness knows a Codex config-file schema.

## Manifest And Image Contract

The repository-owned Codex AgentManifest selects adapter id `codex`, the Codex worker image, pinned runtime version `0.144.1`, native executable paths used by network policy, trusted-inference or explicit credential requirements, and only capabilities proven by this specification.

The Codex image installs the generic worker shim and Codex `0.144.1`, sets the generic shim as its entrypoint, runs as a non-root worker user, and contains no OpenCode or Pi runtime. Its smoke check verifies the exact native version, `codex exec` machine-readable flags, generic shim dry run, non-root identity, and expected worker filesystem layout.

Codex-specific install commands, binary paths, state directories, auth paths, and version pins live only in the Codex AgentManifest, adapter, image, specification, and tests.

## Provenance

Codex runtime provenance is optional and governed by `docs/specs/20260711-worker_runtime_subagent_provenance.md`.

The Codex adapter owns the optional capture lifecycle attached by `prepare` that streams pinned native rollout evidence and projects its index and manifest into the shared session evidence directory. The shared harness owns lifecycle timing and failure cleanup; NanoCore owns evidence verification and import.

Without S33, `--ephemeral` prevents rollout persistence and the harness removes the turn-scoped `CODEX_HOME` after collection. With S33, the harness retains only the AEP-declared bounded provenance artifacts after capture and removes the remaining native state root.

No other adapter is required to imitate Codex rollout files.

## Failure Semantics

- exit zero with an absent final-message file or empty trimmed text returns a successful normalized result with no assistant candidate
- a present final-message path that is not a readable regular UTF-8 file or exceeds 16 MiB fails collection closed
- a non-zero native exit returns a failed adapter classification with bounded, redacted stdout and stderr summaries even when a final-message file exists
- process interruption produces `interrupted` regardless of a partial final-message file
- provenance capture failure invalidates provenance evidence and fails according to the accepted provenance contract
- worker-control failure remains a shared harness failure and stops Codex

## Capability Declaration

The authored manifest is the sole launch-time capability declaration. Adapter conformance and image smoke prove that the manifest advertises only the following supported behavior; `prepare` does not return a second capability declaration:

- bounded turn execution: supported
- workspace edits inside declared writable roots: supported
- normalized final assistant candidate content: supported
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
- isolated `CODEX_HOME`, ignored ambient config/rules, ephemeral cleanup without S33, and bounded retained artifacts with S33
- non-zero exit and redacted failure diagnostics
- exact stdout forwarding when provenance is enabled
- conformance with the shared adapter contract
- rejection of unsupported interactive capabilities

Shared harness tests cover process-group interruption uniformly for Codex, OpenCode, and Pi.

Required image smoke covers the pinned `codex --version`, machine-readable `codex exec` help, generic shim entrypoint, non-root user, and adapter dry run.

## Acceptance

This adapter is clean only when deleting it and its image removes all Codex-native command, output, and provenance knowledge without changing the shared worker contract or NanoCore product and governance core.

## Related Documents

- `docs/changes/202607160036500001-worker_agent_adapter_boundary.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
