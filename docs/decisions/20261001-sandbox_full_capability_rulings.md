---
status: Accepted
date: "2026-10-01"
decider: Engineer
---
# Full Worker Capability Inside The Sandbox

## Decision

The Sandbox is a complete work environment in which workers can use their full capability. Checks protect storage and network policy, external-system Gateway approval and audit, credential custody, Gateway model-route authority, platform data integrity, and OpenKit's runtime control channel: session identity, cancellation, lifecycle, and Turn settlement evidence. Checks that protect none of these boundaries must not restrict in-Sandbox capability. The adapter specifications own the runtime contracts below; docs/core/sandbox.md owns the Sandbox boundary.

1. Codex plugins and hooks load as in-Sandbox user code under the same support boundary as OpenCode plugins and Pi Extensions. OpenKit applies protected bindings at setup; user code that later rewrites them while running is outside supported supply, with no prevention promise.
2. Runtimes launch with full access and full permission inside the Sandbox. A residual native prompt receives the pin's shortest-lived allow, allow once, by default without interrupting the Turn; Pi Extension UI confirmation defaults to true. A user's explicit native deny rule stays. Retain existing programmatic permission decision points and their ability to deny. User-configurable automatic allow, automatic deny, or waiting for a user's approval remain reserved possibilities, none implemented now; add no configuration option, policy type, or abstraction for them. Sandbox containment and Gateway authority remain unchanged.
3. Pi codemode setup is not refused, including static or immediate post-session-start composer registration. OpenKit still supplies no composer. Upstream #10239 remains a stated limitation: codemode may affect a wrong target that the Sandbox permits.
4. A native entry colliding with an OpenKit-protected id does not fail setup. Protected ids include managed providers and model routes, managed MCP servers, selected Skills, host plugins or builtin Extensions, and DeepSeek protected profile rows. OpenKit's binding is applied last and wins; replace the whole entry rather than merge incompatible fields. User files are never edited. Emit a warning through existing worker diagnostics; missing downstream visibility is an Open Item, not a reason to add a protocol member or event.

**Supersedes, in part:** Only the following statements in the earlier records' Decision sections cease to govern; all other decisions remain.

- [Full permission inside the Sandbox](20260930-full_permission_inside_the_sandbox.md): "A native permission request that arrives anyway is rejected, or its prompt is cancelled, and it is never allowed."
- [Adapters honor native configuration](20260930-adapters_honor_native_configuration.md): "Codex plugins and hooks are assessed separately and are not enabled merely by accepting native configuration."
- [Pi codemode support boundary](20261001-pi_codemode_support_boundary.md): the commitment to retain static and immediate post-session-start setup checks, including inactive registration, with `pi-codemode-unsupported` before provider work.
- [OpenCode plugin support boundary](20261001-opencode_plugin_support_boundary.md): the requirement that a detectable native setting or plugin declaration replacing a protected binding fails before provider work.
- [Pi Extension support boundary](20261001-pi_extension_support_boundary.md): the requirement that statically detectable native settings or declared setup replacing a protected binding or host-supplied Extension fail before provider work, and the statement that the bounded codemode checks stay as they are.

## Reason

The engineer said on 2026-10-01, translated from Chinese: "We put workers into Sandboxes and designed many checks and permissions in the adapters, NanoHost and NanoCore. Their purpose is not to restrict agent workers. It is to draw a clear boundary, then hand the Sandbox to agent workers as a complete, fully functional work environment, so they can use their full capability inside it. Restriction is not our essential purpose; the purpose is to give agents more space and flexibility and maximize their capability."

The questions were put to the engineer after an independent Consultant audit. The engineer chose the recommended option for rulings 1, 3, and 4: load Codex plugins and hooks, remove Pi codemode setup refusals while retaining the limitation, and resolve protected-id collisions by applying OpenKit's binding last with a warning. For ruling 2 the engineer said, translated: "Following our principle, these runtimes should be configured at launch with full access and full permission inside the Sandbox."

The engineer later added, translated: "If our current implementation already has a mechanism by which the program can allow once or deny, there is no need to delete it; keep it. In future we may let users configure this freely, for example automatic allow or deny, or waiting for the user to approve; we keep that possibility, but we do not need to implement all of it now."

## Rejected Alternatives

- Keep fail-before-work for protected-id collisions. Applying OpenKit's binding last preserves its setup authority without refusing the user's configuration.
- Reserve a prefix for managed MCP ids. It changes model-visible tool names.
- Cancel a residual prompt without interrupting the Turn. Cancellation still refuses the in-Sandbox action instead of applying full permission.

## Revisit When

- Evidence shows a protected binding applied last does not take effect on a runtime pin.
- A user-facing need arises to configure permission answers.
- Evidence shows an allowed native prompt gains authority beyond the Sandbox boundary or the Gateway.

## Affected Owners

- docs/specs/20260716-codex_worker_adapter.md
- docs/specs/20260716-opencode_worker_adapter.md
- docs/specs/20260716-pi_worker_adapter.md
- docs/specs/20260930-deepseek_worker_adapter.md
- docs/core/sandbox.md
