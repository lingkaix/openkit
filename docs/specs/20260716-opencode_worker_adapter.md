---
status: Accepted
implementation: Implemented
updated: 2026-08-21
---
# OpenCode Worker Adapter

## Summary

The OpenCode Worker Adapter translates one resolved Agent Environment Package into one bounded OpenCode process and translates its machine-readable native event stream into the shared OpenKit worker harness result.

The current product path uses OpenCode's one-shot run surface. The OpenCode HTTP server is not a second OpenKit control plane and is not required for one bounded worker turn.

This adapter remains in the shared registry's `bounded-turn` mode. It is not eligible for the multi-AgentSession shared-Harness RuntimeTarget until this owning specification accepts and the pinned runtime proves the complete `session-continuity` contract; the Codex implementation does not implicitly broaden OpenCode.

## Owns

- OpenCode command construction for one bounded worker turn
- bounded parsing of OpenCode JSON output
- final assistant text extraction from OpenCode-native records
- OpenCode-specific version, event compatibility, and failure tests
- OpenCode-specific failure mapping and conformance evidence for manifest-declared capabilities

## Does Not Own

- OpenCode server lifecycle inside NanoCore
- child process supervision, worker-control, canonical transcript writing, or workspace publication
- AEP resolution, provider selection, credential grants, network policy, or backend lifecycle
- product state, scheduling, review, apply, Action Center, or public API behavior
- a translation of every OpenCode native event into the canonical worker protocol

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-supply.md`
- `docs/core/sandbox.md`

## Upstream Contract

The accepted implementation pin is official OpenCode `v1.18.1`, commit `99f638d8293f6985726ba509da602296c4963497`, installed as `opencode-ai@1.18.1`.

The bounded native command uses the pinned OpenCode CLI machine-readable run surface:

```text
opencode run --format json --dir <workspace> --model <provider/model> <turn-input>
```

The adapter spawns argv directly without a shell and never passes `--auto`. The pinned non-interactive path denies native question and plan-transition permissions and rejects other permission requests, which matches the current fail-closed bounded Worker contract rather than fabricating live approval support.

The native `opencode serve` HTTP surface is reserved for a future accepted interactive-session requirement. It must not be introduced only to imitate an OpenKit control gateway or to expose OpenCode-native HTTP routes to NanoCore.

## AEP Inputs Consumed

The shared harness supplies the adapter with:

- adapter id
- turn input
- worker working directory
- session directory
- the provider, model, endpoint, and credential bindings from the AEP's one already resolved LLM route
- a safe child environment without the worker-control token

The adapter does not resolve providers, credentials, models, permissions, Skills, MCP authorization, or workspace policy.

The shared harness supplies one fresh empty session state root. `prepare` assigns a fresh `HOME` plus turn-scoped `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` directories beneath it and sets `OPENCODE_AUTH_CONTENT={}`, `OPENCODE_PURE=1`, `OPENCODE_DISABLE_SHARE=1`, `OPENCODE_AUTO_SHARE=0`, `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`, `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, `OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, and `OPENCODE_DISABLE_LSP_DOWNLOAD=1`.

## Launch Plan

`prepare` returns one native launch command, safe environment additions, and a request for bounded exact stdout capture because final output is encoded in the JSON event stream. The plan has no config-artifact field.

No environment variable, AEP extension, test option, or image diagnostic may replace the adapter-produced argv. Tests inject a process runner or a static test adapter without creating a production command override, and NanoCore never constructs an OpenCode command.

The adapter contract has no separate interrupt operation. The shared harness owns process-group termination.

## Native Output Mapping

`collect` parses stdout as newline-delimited JSON under the shared 16 MiB native-output bound. Exceeding the bound fails collection closed.

It ignores unknown event types for forward tolerance, rejects malformed JSON records that prevent a trustworthy final result, and handles the pinned `step_start`, `text`, `step_finish`, and `error` records.

The adapter tracks the latest `step_start.part.messageID`, collects subsequent completed and non-ignored `text` parts with the same message id, preserves stream order, and joins non-empty part text with a blank line. Success requires exit code zero, no native `error` record, and a terminal `step_finish` for the tracked assistant message.

Native OpenCode event names, tool-call records, provider payloads, and session objects remain inside the adapter. They are not added to `packages/worker-protocol` and do not enter NanoCore.

The adapter returns a normalized final assistant message and adapter-local diagnostics. The shared harness writes schema-conformant candidate records, NanoCore alone validates and commits canonical product state, and the harness retains at most a 16 KiB prefix from each of stdout and stderr for failure diagnostics before redaction.

## Control Mapping

- `interrupt` terminates the supervised OpenCode process group through the shared harness.
- OpenCode session continuation is not advertised in the bounded adapter.
- OpenCode server abort, permission, question, and event subscription APIs are not exposed until OpenKit accepts and tests a corresponding product control contract.

The OpenCode adapter implements only `prepare` and `collect`; it does not implement an adapter-local interrupt operation.

## Skills And MCP

NanoCore may resolve approved static Skill and MCP supply into the AEP, but the delivered selected-MCP capability slice is restricted to the Codex session-continuity adapter. OpenCode remains ineligible and must not discover, install, connect directly, authorize, or broaden supply.

## Provider And Credentials

The authored AgentManifest owns provider, model, credential, backend-capability, and network requirements; the resolved AEP owns the exact selected route, credential binding, and effective launch policy. Credential attachments are materialized through the governed backend and vault declarations. The adapter consumes the AEP's one resolved route, expresses OpenCode-native setup only through argv and safe environment additions, rejects zero or multiple routes, and never introduces a provider default or fallback into NanoCore or the shared harness.

Native route projection is adapter-specific. For the trusted relay, argv selects the fixed slash-free adapter-owned model name `openkit-worker-inference/<exact-model-id>`, while `OPENCODE_CONFIG_CONTENT` is the JSON serialization of this non-secret shape:

```json
{
  "autoupdate": false,
  "share": "disabled",
  "enabled_providers": ["openkit-worker-inference"],
  "model": "openkit-worker-inference/<exact-model-id>",
  "provider": {
    "openkit-worker-inference": {
      "name": "OpenKit Worker Inference",
      "npm": "@ai-sdk/openai",
      "options": {
        "baseURL": "http://127.0.0.1:17892/inference/v1",
        "apiKey": "{env:OPENKIT_WORKER_INFERENCE_TOKEN}"
      },
      "models": {
        "<exact-model-id>": { "name": "<exact-model-id>" }
      }
    }
  }
}
```

The adapter JSON-serializes the exact model id and uses the fixed Sandbox Integration base URL rather than interpolating either value. The AEP provider instance id remains NanoCore evidence and is not used as the OpenCode native provider id.

`OPENCODE_CONFIG_CONTENT` is an environment value, not a generated file. It contains only the credential environment-variable reference, never the placeholder or provider credential value. The governed AgentManifest and adapter isolation above disable ambient project configuration, auth content, configured and default plugins, Claude Code prompts/skills, external Skills, model fetches, sharing, updates, and LSP downloads. Approved static file supply is added back only through the AEP.

Direct-provider routes are unsupported in this change because the current AEP route does not carry a separately proved native provider or SDK, wire protocol, and exact credential target. The adapter must not infer any of them from a provider id. Direct and otherwise unsupported routes fail before spawn rather than receiving a fallback or additional generic route fields.

## Manifest And Image Contract

The repository-owned OpenCode AgentManifest selects adapter id `opencode`, the OpenCode worker image, native executable paths used by network policy, provider and credential requirements, the configuration-isolation variables above, and only capabilities proven by this specification.

The OpenCode image installs the generic worker shim and `opencode-ai@1.18.1`, sets the generic shim as its entrypoint, runs as a non-root worker user, and contains no Codex or Pi runtime. Because pinned OpenCode loads managed configuration after inline configuration and offers no disabling flag, the Linux image must prove that `/etc/opencode` is absent. Its smoke check verifies that invariant, the exact native version, JSON run mode, generic shim dry run, ambient configuration isolation, non-root identity, and expected worker filesystem layout.

OpenCode-specific install commands, binary paths, environment isolation, event fixtures, and version pins live only in the OpenCode AgentManifest, adapter, image, specification, and tests.

## Failure Semantics

- malformed or over-limit native output fails adapter collection closed
- exit zero succeeds only with no native `error` record plus a tracked assistant `step_start` and matching terminal `step_finish`; zero non-empty text parts then yields no assistant candidate
- malformed records that prevent proving that sequence, a missing tracked assistant message, or a missing matching terminal `step_finish` fail collection closed
- a non-zero native exit returns a failed adapter classification with bounded, redacted diagnostics even when completed text exists
- interruption wins over any partial final assistant content
- worker-control failure stops the OpenCode process through the shared harness
- the harness deletes the turn-scoped XDG roots after collection and never retains native session ids

## Capability Declaration

The authored manifest is the sole launch-time capability declaration. Adapter conformance and image smoke prove that the manifest advertises only the following supported behavior; `prepare` does not return a second capability declaration:

- bounded turn execution: supported
- workspace edits inside declared writable roots: supported
- normalized final assistant candidate content: supported
- interrupt by process termination: supported
- live native token streaming into product Items: not supported
- native approval or question round trips: not supported
- OpenCode HTTP server exposure: not supported
- multi-turn native session resume: not supported by this adapter contract

## Tests

Required adapter tests cover:

- exact command construction and exact non-secret inline provider JSON from adapter input
- fixed slash-free native provider id, credential-value absence, and direct or otherwise unsupported route rejection
- final assistant extraction from pinned native JSON fixtures
- unknown event tolerance
- malformed JSON, missing final output, and byte-bound failures
- non-zero exit and redacted diagnostics
- ambient config/plugin/share/MCP isolation, turn-scoped XDG state, and post-collection deletion
- conformance with the shared `bounded-turn` adapter contract also used by Pi

Shared harness tests cover process-group interruption uniformly for Codex, OpenCode, and Pi.

Required image smoke covers the pinned `opencode --version`, JSON run mode help, generic shim entrypoint, non-root user, absence of `/etc/opencode`, and adapter dry run.

## Implementation Evidence And Limit

The OpenCode `1.18.1` bounded-turn adapter, static registry entry, authored manifest, pinned worker image, bounded `prepare`/`collect` tests, and refreshed image smoke are implemented. OpenCode is intentionally ineligible for the target shared-Harness RuntimeTarget because no accepted or implemented session-continuity adapter exists. The refreshed 2026-07-21 arm64 image builds locally and passes its complete smoke. The earlier minimal arm64 image passed stock unpatched OpenShell `0.0.80` create, upload, generic-shim dry-run, and delete on A1, but that historical run is not refreshed-image OpenShell evidence.

This dry run proves image contents, adapter preparation, stock OpenShell containment, upload, and cleanup. It does not prove a real-provider turn, worker-control readiness, heartbeat, interruption, reconnect, or recovery lifecycle; those remain acceptance obligations of their owning specifications and change packages.

## Acceptance

This adapter is clean only when deleting it and its image removes all OpenCode command and event knowledge without changing NanoCore, the shared harness contract, or canonical worker schemas.

## Upstream Evidence

- `https://github.com/anomalyco/opencode/commit/99f638d8293f6985726ba509da602296c4963497`
- `https://github.com/anomalyco/opencode/blob/99f638d8293f6985726ba509da602296c4963497/packages/web/src/content/docs/index.mdx`
- `https://github.com/anomalyco/opencode/blob/99f638d8293f6985726ba509da602296c4963497/packages/opencode/src/cli/cmd/run.ts`
- `https://github.com/anomalyco/opencode/blob/99f638d8293f6985726ba509da602296c4963497/packages/web/src/content/docs/server.mdx`

## Related Documents


- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-worker_control_protocol.md`
