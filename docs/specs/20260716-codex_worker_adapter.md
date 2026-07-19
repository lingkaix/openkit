# Codex Worker Adapter

Status: Accepted
Implementation: Implemented

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
codex exec --json --ignore-user-config --ignore-rules --strict-config [--ephemeral] --output-last-message <session-final-message-path> --cd <workspace> <adapter-owned -c provider projection> --model <model> --dangerously-bypass-approvals-and-sandbox <turn-input>
```

Every invocation also uses `--ignore-user-config` and `--ignore-rules`. When S33 provenance is disabled it uses `--ephemeral`; when S33 provenance is required it omits `--ephemeral` only so the pinned rollout files can be captured from a fresh turn-scoped `CODEX_HOME`.

The approval and sandbox bypass flag is permitted only because the authored AgentManifest and resolved AEP declare the filesystem, network, credential, image, and binary authority that stock OpenShell enforces around the process, while NanoCore retains canonical review and external-side-effect decisions. It must never be used to create a host runtime path.

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

No environment variable, AEP extension, test option, or image diagnostic may replace the adapter-produced argv. Tests inject a process runner or a static test adapter without creating a production command override.

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

The authored AgentManifest owns provider, model, credential, backend-capability, and network requirements; the resolved AEP owns the exact selected route, credential binding, and effective launch policy. NanoCore performs that resolution but does not own a second native-runtime configuration.

The AEP remains authoritative for the selected route, but native route projection is adapter-specific. NanoCore and the shared harness must not infer Codex provider configuration. The adapter rejects zero or multiple routes and any route whose exact endpoint, credential binding, model, or wire protocol Codex `0.144.1` cannot represent.

For the trusted NanoCore relay, the adapter uses the fixed adapter-owned provider id `openkit-worker-inference`; it never projects an arbitrary AEP provider id into Codex. Its argv contains TOML-quoted `-c` values equivalent to:

```text
model_provider="openkit-worker-inference"
web_search="disabled"
model_providers.openkit-worker-inference.name="OpenKit Worker Inference"
model_providers.openkit-worker-inference.base_url="<exact workerBaseUrl>"
model_providers.openkit-worker-inference.env_key="OPENKIT_WORKER_INFERENCE_TOKEN"
model_providers.openkit-worker-inference.wire_api="responses"
model_providers.openkit-worker-inference.requires_openai_auth=false
```

The child environment carries only the OpenShell-injected `OPENKIT_WORKER_INFERENCE_TOKEN` placeholder. Its value must not appear in argv, native configuration, diagnostics, or evidence. Codex `0.144.1` supports only the Responses wire API through this projection, so a Chat-Completions-only relay is unsupported.

Direct-provider routes are unsupported in this change because the current AEP route does not carry a separately proved Responses wire protocol and exact credential target for truthful Codex projection. Direct, Chat Completions, Anthropic Messages, Gemini, and other non-relay routes fail closed before spawn. The adapter never substitutes a direct route for the trusted relay, and neither NanoCore nor the shared harness knows a Codex config-file schema.

## Manifest And Image Contract

The repository-owned Codex AgentManifest selects adapter id `codex`, the Codex worker image, pinned runtime version `0.144.1`, native executable paths used by network policy, trusted-relay requirements, and only capabilities proven by this specification.

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

- exact command construction, TOML quoting, fixed native provider id, model, base URL, environment-key reference, and Responses-only rejection from an adapter input
- proof that credential values never enter argv or evidence and direct routes fail before spawn
- rejection of retired environment and AEP-extension command overrides
- final-message success, absence, non-file, and size-bound behavior
- isolated `CODEX_HOME`, ignored ambient config/rules, ephemeral cleanup without S33, and bounded retained artifacts with S33
- non-zero exit and redacted failure diagnostics
- exact stdout forwarding when provenance is enabled
- conformance with the shared adapter contract
- rejection of unsupported interactive capabilities

Shared harness tests cover process-group interruption uniformly for Codex, OpenCode, and Pi.

Required image smoke covers the pinned `codex --version`, machine-readable `codex exec` help, generic shim entrypoint, non-root user, and adapter dry run.

## Implementation Evidence And Limit

The Codex `0.144.1` adapter, static registry entry, authored manifest, pinned worker image, bounded `prepare`/`collect` tests, and image smoke are implemented. On A1, the arm64 image was built directly, passed its smoke check, and stock unpatched OpenShell `0.0.80` created a sandbox from it, uploaded the AEP package, completed the generic shim dry run, and deleted the sandbox after the Cell's separate same-tag image cache was refreshed.

This dry run proves image contents, adapter preparation, stock OpenShell containment, upload, and cleanup. It does not prove a real-provider turn, worker-control readiness, heartbeat, interruption, reconnect, or recovery lifecycle; those remain acceptance obligations of their owning specifications and change packages.

## Acceptance

This adapter is clean only when deleting it and its image removes all Codex-native command, output, and provenance knowledge without changing the shared worker contract or NanoCore product and governance core.

## Related Documents

- `docs/changes/202607160036500001-worker_agent_adapter_boundary.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
