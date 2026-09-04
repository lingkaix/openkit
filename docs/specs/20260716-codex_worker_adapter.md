---
status: Accepted
implementation: Partial
updated: 2026-08-21
---
# Codex Worker Adapter

## Summary

The Codex Worker Adapter translates one open AgentSession and each freshly resolved Turn into a bounded `codex exec` process, resumes the exact Codex conversation across later process instances, and translates Codex-native output and optional rollout evidence into the shared OpenKit Harness result.

The adapter is worker-side integration code. It is not a NanoCore runtime, transport, policy engine, product model, or provider owner.

## Owns

- Codex session-local state and restricted native conversation-handle lifecycle
- Codex command construction for one first or resumed bounded worker Turn
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

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-supply.md`
- `docs/core/sandbox.md`

## Upstream Contract

The accepted implementation pin is Codex CLI `0.144.1`, matching the real worker image and runtime-provenance fixtures.

The first bounded native command is equivalent to:

```text
codex exec --json --ignore-user-config --ignore-rules --strict-config --output-last-message <turn-final-message-path> --cd <workspace> <adapter-owned -c provider and selected-MCP projections> --model <model> --dangerously-bypass-approvals-and-sandbox <turn-input>
```

Every later Turn uses the same accepted safe flags and provider and selected-MCP projections with the pinned native resume surface; the Harness sets the child working directory because the resume subcommand has no `--cd` option:

```text
codex exec resume --json --ignore-user-config --ignore-rules --strict-config --output-last-message <turn-final-message-path> <adapter-owned -c provider and selected-MCP projections> --model <model> --dangerously-bypass-approvals-and-sandbox <exact-native-thread-id> <turn-input>
```

Codex `0.144.1` exposes `exec resume [SESSION_ID] [PROMPT]`; a UUID selects the exact thread and neither `--last`, title search, cwd search, nor another discovery fallback is permitted. Session-continuity mode never uses `--ephemeral`, because persistence beneath the AgentSession-private `CODEX_HOME` is the native mechanism that a later process instance resumes. Every invocation uses `--ignore-user-config` and `--ignore-rules`.

The approval and sandbox bypass flag is permitted only because the authored AgentManifest and resolved AEP declare the filesystem, network, credential, image, and binary authority that stock OpenShell enforces around the process, while NanoCore retains canonical review and external-side-effect decisions. It must never be used to create a host runtime path.

## AEP Inputs Consumed

The shared harness supplies the adapter with:

- adapter id
- turn input
- worker working directory
- AgentSession-private state directory and Turn-private final-message path
- the provider, model, endpoint, and credential bindings from the AEP's one already resolved LLM route
- the exact selected MCP server ids from AEP supply and the Turn-local capability token only through the safe `OPENKIT_WORKER_CAPABILITY_TOKEN` environment binding
- optional native provenance declaration
- a safe child environment that excludes the worker-control credential and contains only the separately authorized inference and enabled capability route tokens

The adapter must not read NanoCore private storage or invent missing provider, model, policy, or credential decisions.

The shared Harness supplies one fresh empty AgentSession-private state root. `openSession` selects its fixed `CODEX_HOME`, reports the native handle `pending`, and starts no process because the pinned CLI creates a conversation only with the first prompt. `prepareTurn` selects a fresh Turn-private final-message path beneath that AgentSession, uses the first command when no handle exists, and uses exact UUID resume when the binding already holds one proved handle. It returns no config or authentication files. AEP-resolved authentication and provider material may enter the child only through backend-materialized credential bindings and adapter-owned argv or safe environment. For each exact selected MCP server id, the adapter adds only `mcp_servers.<id>.url="http://127.0.0.1:17892/capabilities/mcp/<id>"` and `mcp_servers.<id>.bearer_token_env_var="OPENKIT_WORKER_CAPABILITY_TOKEN"` through inline `-c`; the raw token remains only in that environment variable and never enters argv. Unselected executable MCP entries, hooks, memories, sibling AgentSessions, ambient user state, and config artifacts are absent. `--ignore-user-config` and `--ignore-rules` prevent the native runtime from treating Workspace policy files as hidden execution authority.

## Launch Plan

`prepareTurn` returns a native launch plan containing command argv, safe child environment additions, whether exact stdout capture is required, and the final assistant extraction strategy. The plan has no config-artifact field.

No environment variable, AEP extension, test option, or image diagnostic may replace the adapter-produced argv. Tests inject a process runner or a static test adapter without creating a production command override.

`collectTurn` requires exactly one `thread.started` event whose UUID equals the binding's existing native handle on resume or establishes the handle on the first Turn. It also requires the session-local rollout metadata to identify that same thread before returning the lowercase SHA-256 handle digest used by private Harness proof. The raw UUID remains only in the AgentSession-private adapter state and is never a product field, ordinary diagnostic, command result, or authorization input.

`inspectSession` proves whether no child is active, whether the exact handle and same-thread session metadata remain available, and whether Turn-private writers are absent. `closeSession` is admitted only without an active child, removes the complete AgentSession-private `CODEX_HOME` and Turn-local outputs, and returns exact absence proof. The adapter contract has no separate interrupt or provenance operation; the shared Harness owns process-group termination, while `prepareTurn` may attach the existing Codex-local provenance sink lifecycle to the launch plan.

## Native Output Mapping

Codex writes the final assistant response to the bounded `--output-last-message` file. `collectTurn` validates that the path is a regular file, applies the shared 16 MiB bound, decodes UTF-8, trims surrounding whitespace, and returns either one assistant message or no message together with the exact native-handle proof above.

Codex JSONL stdout is not imported directly into NanoCore product state. When runtime provenance is enabled, exact stdout bytes are passed to the Codex provenance capture implementation and finalized only after a successful shared harness lifecycle.

Outside the separately bounded streaming provenance path, native result content is limited to 16 MiB. The shared process runner retains at most a 16 KiB prefix from each of stdout and stderr for failure diagnostics before redaction.

Malformed native events may invalidate provenance evidence, but they must not bypass candidate terminal classification or cause NanoCore to accept native Codex schemas.

`collectTurn` returns normalized assistant content or a product-safe failure classification. The shared Harness emits schema-conformant candidate records, and NanoCore alone validates and commits canonical Items and terminal state.

## Control Mapping

The target OpenKit worker envelope is one open Codex AgentSession with zero or more sequential bounded Turns and at most one active Turn in that AgentSession.

- `session.open` creates the private state root and a pending handle without starting Codex;
- the first `turn.start` launches a new conversation and settles with a pending handle once the supervised child is running; successful terminal `collectTurn` establishes the exact returned thread UUID and `session.inspect` proves it before reuse;
- a later `turn.start` launches a fresh `codex exec resume` process against that exact UUID and same private `CODEX_HOME`;
- `turn.interrupt` terminates only the supervised process group for that AgentSession through the shared Harness;
- `session.inspect` and `session.close` use the fixed adapter operations above;
- native approval requests, questions, steering, and follow-up remain unsupported.

Another resident AgentSession belongs to another Thread and has a distinct private `CODEX_HOME`, native handle, child process, Turn slots, route credentials, and cleanup proof even when it selects the same Agent, image, model, or provider. The Codex adapter implements no adapter-local interrupt operation and never selects an AgentSession by `--last`, title, cwd, sibling state, or ambient Codex home.

## Skills And MCP

NanoCore resolves approved static Skill and selected MCP supply into the AEP. When selected MCP supply is non-empty, the Codex adapter projects only those ids through the fixed authenticated loopback URLs above; NanoCore still owns catalog resolution, authorization, credentials, transport, usage, and audit, and the adapter must not discover, install, connect directly, authorize, or broaden supply. With no selected MCP server the capability plane remains disabled and no MCP override is emitted.

## Provider And Credentials

The authored AgentManifest owns provider, model, credential, backend-capability, and network requirements; the resolved AEP owns the exact selected route, credential binding, and effective launch policy. NanoCore performs that resolution but does not own a second native-runtime configuration.

The AEP remains authoritative for the selected route, but native route projection is adapter-specific. NanoCore and the shared harness must not infer Codex provider configuration. The adapter rejects zero or multiple routes and any route whose exact endpoint, credential binding, model, or wire protocol Codex `0.144.1` cannot represent.

For the trusted NanoCore relay, the adapter uses the fixed adapter-owned provider id `openkit-worker-inference`; it never projects an arbitrary AEP provider id into Codex. Its argv contains TOML-quoted `-c` values equivalent to:

```text
model_provider="openkit-worker-inference"
web_search="disabled"
model_providers.openkit-worker-inference.name="OpenKit Worker Inference"
model_providers.openkit-worker-inference.base_url="http://127.0.0.1:17892/inference/v1"
model_providers.openkit-worker-inference.env_key="OPENKIT_WORKER_INFERENCE_TOKEN"
model_providers.openkit-worker-inference.wire_api="responses"
model_providers.openkit-worker-inference.requires_openai_auth=false
```

The child environment always carries the OpenShell-injected `OPENKIT_WORKER_INFERENCE_TOKEN` placeholder and carries `OPENKIT_WORKER_CAPABILITY_TOKEN` only when the exact AEP-selected MCP supply enables the capability route. No worker-control or other route token enters the native environment, and neither value may appear in argv, native configuration text, diagnostics, or evidence. Codex `0.144.1` supports only the Responses wire API through the inference projection, so a Chat-Completions-only relay is unsupported.

Direct-provider routes are unsupported in this change because the current AEP route does not carry a separately proved Responses wire protocol and exact credential target for truthful Codex projection. Direct, Chat Completions, Anthropic Messages, Gemini, and other non-relay routes fail closed before spawn. The adapter never substitutes a direct route for the trusted relay, and neither NanoCore nor the shared harness knows a Codex config-file schema.

## Manifest And Image Contract

The repository-owned Codex AgentManifest selects adapter id `codex`, the Codex worker image, pinned runtime version `0.144.1`, native executable paths used by network policy, trusted-relay requirements, and only capabilities proven by this specification.

The Codex image installs the generic worker shim and Codex `0.144.1`, sets the generic shim as its entrypoint, runs as a non-root worker user, and contains no OpenCode or Pi runtime. Its smoke check verifies the exact native version, `codex exec` machine-readable flags, generic shim dry run, non-root identity, and expected worker filesystem layout.

Codex-specific install commands, binary paths, state directories, auth paths, and version pins live only in the Codex AgentManifest, adapter, image, specification, and tests.

## Provenance

Codex runtime provenance is optional and governed by `docs/specs/20260711-worker_runtime_subagent_provenance.md`.

The Codex adapter owns the optional capture lifecycle attached by `prepareTurn` that streams pinned native rollout evidence and projects its index and manifest into the shared session evidence directory. The shared Harness owns lifecycle timing and failure cleanup; NanoCore owns evidence verification and import.

The AgentSession-private rollout forest is required native continuity state and remains until `session.close`, independent of whether S33 product-safe provenance export is enabled. S33 controls only bounded evidence projection into declared outputs; it does not control native state persistence. Turn-private final-message and transient capture files are removed after collection, while `session.close` removes the remaining private `CODEX_HOME` after exact child and writer absence.

No other adapter is required to imitate Codex rollout files.

## Failure Semantics

- exit zero with an absent final-message file or empty trimmed text returns a successful normalized result with no assistant candidate
- a present final-message path that is not a readable regular UTF-8 file or exceeds 16 MiB fails collection closed
- a non-zero native exit returns a failed adapter classification with bounded, redacted stdout and stderr summaries even when a final-message file exists
- process interruption produces `interrupted` regardless of a partial final-message file
- missing, malformed, multiple, changed, or sibling `thread.started` identity fails the Turn and makes the binding non-reusable until exact cleanup
- missing or conflicting same-thread rollout metadata, exact resume refusal, or a resume that reports another thread drains the AgentSession binding and never falls back to a new conversation
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
- multi-Turn native continuity through exact UUID and AgentSession-private `CODEX_HOME`: implemented
- optional runtime provenance: supported only by the pinned image and accepted AEP feature

## Tests

Required adapter tests cover:

- exact command construction, TOML quoting, fixed native provider id, model, base URL, environment-key reference, and Responses-only rejection from an adapter input
- proof that credential values never enter argv or evidence and direct routes fail before spawn
- rejection of retired environment and AEP-extension command overrides
- final-message success, absence, non-file, and size-bound behavior
- distinct-Thread AgentSession-private `CODEX_HOME` roots, rejection of two current bindings for one Thread, ignored ambient config/rules, pending first-start settlement, exact handle establishment through terminal `collectTurn` and `session.inspect`, exact-UUID resume by a later process instance, sibling rejection, and complete AgentSession-close cleanup
- non-zero exit and redacted failure diagnostics
- exact stdout forwarding when provenance is enabled
- conformance with the shared adapter contract
- rejection of `--last`, title, cwd, ambient-home, missing-handle, conflicting-handle, and unsupported interactive capability paths

Shared harness tests cover process-group interruption uniformly for Codex, OpenCode, and Pi.

Required image smoke covers the pinned `codex --version`, machine-readable `codex exec` help, generic shim entrypoint, non-root user, and adapter dry run.

## Implementation Evidence And Limit

The Codex `0.144.1` session-continuity adapter, static registry entry, authored manifest, pinned worker image definition, five-operation adapter tests, retained AgentSession-private state, exact first-Turn handle binding, exact-UUID resume, inspection, close, and multi-AgentSession Harness integration are implemented and pass local checks. OpenCode and Pi retain their bounded `prepare`/`collect` paths. The earlier 2026-07-21 arm64 image build passed its complete smoke, and the earlier minimal arm64 image passed stock unpatched OpenShell `0.0.80` create, upload, generic-shim dry-run, and delete on A1; the current image bytes plus refreshed stock OpenShell, provider, interrupt, reconnect, and recovery evidence are still required.

This dry run proves image contents, adapter preparation, stock OpenShell containment, upload, and cleanup. It does not prove a real-provider turn, worker-control readiness, heartbeat, interruption, reconnect, or recovery lifecycle; those remain acceptance obligations of their owning specifications and change packages.

## Acceptance

This adapter is clean only when deleting it and its image removes all Codex-native command, output, and provenance knowledge without changing the shared worker contract or NanoCore product and governance core.

## Related Documents


- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
