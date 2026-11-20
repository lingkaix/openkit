---
status: Accepted
kind: boundary
implementation: Partial
aspect: agent-session
---

# Codex Worker Adapter

This specification owns the Codex 0.169.0 App Server delta. Shared adapter rules live in [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md).

## Scope

Owns the Codex App Server v2 mapping, its private home, retaining close, and host-managed Login.

Does not own:

- The shared adapter base. [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md) owns it.
- Private Harness operations. [Worker Control Protocol](20260703-worker_control_protocol.md) owns them.
- The image. [Worker Execution Environment Images](20260721-worker_execution_environment_images.md) owns it.
- Provenance collection. [Worker Runtime Subagent Provenance](20260711-worker_runtime_subagent_provenance.md) owns it.
- Public live steer. [Task Mode](20260704-task_mode_worker_delegation.md) owns it.

Core: [AgentSession](../core/agent-session.md), [Sandbox](../core/sandbox.md).

## Runtime

The pin uses Codex App Server v2 over local stdio, the generated schema that matches that binary, and the fixed production binary. There is no `codex exec`, SDK, or ACP path ([four native runtime adapters](../decisions/20260929-four_native_runtime_adapters.md)).

## Launch And Session Mapping

`CODEX_HOME` is the whole admitted state root. The exact raw native UUID stays private. The adapter does not generate a base config, a sessions symlink, or a filename filter over the retained home ([Codex home retained whole](../decisions/20260930-codex_home_retained_whole.md)).

Open performs the handshake. A new binding stays pending until the first bound Turn creates the exact thread and a nonempty rollout. A resumed open proves that exact thread and makes no capability contact.

### Reasoning Effort Delivery

Native effort is `turn/start.effort` on the exact thread. Canonical names stay unchanged, including the explicit `none` string. Omitting effort on a non-reasoning route stays local to this adapter. The Gateway removes a stale native effort on a no-reasoning route ([runtime upgrade](../decisions/20261031-worker_runtimes_upgrade_to_latest.md)).

The trusted relay uses the fixed `openkit-worker-inference` provider, the loopback Responses endpoint, `requires_openai_auth: false`, and no web search. A generic direct route or a non-Responses route refuses.

### Host Managed Subscription Login

Host Login uses private `account/login/start` `chatgptAuthTokens` and asynchronous refresh. The admitted binding is exact. Core is the only refresher. The refresh credential does not enter the Sandbox, and there is no auth-file lease or write-back. Enablement requires the package, the resolver, the adapter, and the private exchange together. There is no silent fall back to the relay.

A fallback model descriptor is used only when this pin still needs one. The logical model stays exact. The descriptor carries no caller catalog, credential, or grant, and it is not retained. Failure to create it prevents the Turn.

Filesystem inspection uses a separate 1 second current default and rechecks the same usable child after the await. Monotonic control deadlines do not limit ordinary inference.

The adapter protects only native state destination names it has proved, in addition to the shared bootstrap names. A prefix alone is not protected. Credential-value exclusion is a separate check.

### Live Steer Mapping And Qualification

At 0.166.0, steer maps to `turn/steer` with the exact `threadId` and `expectedTurnId`. The returned `turnId` correlates with the public Item and digest. Stale, busy, or invalid input refuses. An uncertain RPC fences the slot and does not resend.

Codex App Server 0.166.0 correlates native intake through the expected Turn and the returned native Turn ID. This qualifies the acceptance observation only. To discharge the kernel obligation, read the original input through receiver evidence identifying its processing on that exact native Turn. Qualification must cover lost steer ACK, exact original Items after reconnect, two equal-text inputs, idle/terminal race and no successor spill. Processing read-back on this pin is unqualified until those checks pass. Refuse any path without the required same-Turn guard before contact. Preserve an unknown result after possible contact and never resend it. [Retained Delivery Proof](20260703-worker_control_protocol.md#retained-delivery-proof) owns the common evidence.

## Event Mapping

### Native Output Mapping

The adapter validates a correlated `turn/completed`, the closed status and item alternatives, and the exact thread and Turn. `contextWindowExceeded` together with `failed` proves length. Commentary and `partial_answer` are excluded. More than one final candidate is rejected ([Truthful Native Stop Classification](../decisions/20261009-truthful_native_stop_classification.md)).

Diagnostics use the addressed Turn's stderr only. Protocol stdout is not a diagnostic. The prefix is redacted and then cut at 16 KiB of valid UTF-8. The older stdout-summary wording is not current behavior.

The adapter continues parsing buffered stdout after process exit through EOF and the final UTF-8 flush. A stream failure is not hidden by arrival of the terminal record.

Native turn metadata is checked against the complete body projection. Only body-only `tool_namespaces_info` is excluded from that comparison. Each encoded input is at most 16 KiB. The adapter emits only an ephemeral native phase and lineage hint ([Native Compaction Phase Hint](../decisions/20261016-native_compaction_phase_hint.md)).

`environments.environment_context` preludes are recognized separately from `user.text`. Preludes are excluded from the message projection. Unchanged-prefix proof still covers their bytes.

Account, `rateLimits/read`, and updated observations are projected only for the current account, receipt, and generation. A late or unknown observation is discarded. The adapter keeps no quota store and no poller.

A channel, malformed, unknown, duplicate, contradictory, or uncorrelated terminal record poisons the binding monotonically. Only a confirmed stop of the dedicated process allows failed settlement.

## Deviations From The Base Contract

The first bound Turn applies the working directory and MCP once. The exact managed HTTP overlay wins. This pin cannot replace a protected authored non-HTTP entry, so that collision refuses before thread configuration and before the prompt, with a rename warning, instead of only the credential-free warning in [Adapter Base Contract](20260629-worker_runtime_communication_model.md#adapter-base-contract). The complete selected Skill-root set is refreshed on each Turn, including the empty set, without deleting native local Skills, under [Static Supply Projection](20260629-worker_runtime_communication_model.md#static-supply-projection). That refresh is not a managed MCP re-list.

Retaining close is qualified only for an idle, settled, completed or requested-interrupted, text-only, paginated history. It uses `thread/read` with `includeTurns` on the same thread, the exact native order and terminals, and a contiguous retained prefix. The close fence spans that barrier and a normal EOF stop. It requires stdout and stderr EOF and a byte-identical prefix after exit. A context-changing close notification invalidates the proof. A forced stop cannot fill in missing flush proof.

`token_usage_record` is allowed only for the same Thread and root Turn, inside the live barrier between its context and the raw terminal. Accounting replaces neither the text nor the terminal fact.

Each requested-interrupted Turn needs exactly one `generic.turn_aborted` marker before the matching interrupted raw terminal. A missing, duplicate, foreign, or later marker refuses.

## Unsupported Operations

Compacted history, a child writer, tool history, a failed history, an unsupported history, an orphan patch, and a resume that has no new settled Turn stay outside qualified retaining close. Refusal preserves the bytes.

The shortest native command, file, and MCP permission is accept. Additional permissions last for the current Turn only. Unsupported user input and unknown requests poison the binding. Permission records use a current default bound of 16 diagnostic records and reset each Turn. Labels stay the fixed safe set. This bound is not a user setting or an authorization quota.

## Acceptance

### Tests

If a fallback descriptor is required, qualification shows the exact native freeform patch and one bounded real native edit. Operation assertions alone are not enough.

Native steer qualification includes a wrong Turn, terminal and interrupt races, a lost or slow response, and no spill onto the exact successor. Source or schema presence is not that proof.

Real-pin retaining-close and successor evidence includes 20 independent bindings and an interruption that preserves siblings. That evidence proves only the local text-history path. It does not prove descendant absence, Sandbox absence, or stable-media durability.

A deployed Sandbox qualifies whole-home credential absence, external-authority isolation, native plugins and hooks, image defaults, and the loaded system requirements. Local synthetic probes do not close that proof.

Cross-account continuation is qualified or refused. Host-managed Login and server-side compaction require the real Worker path. Sealed reasoning is never replayed or spliced.

Native system defaults stay enabled below the user and session layers. Image application, protected precedence, and invalid system requirements require image qualification. There is no guessed redirect or initializer.

## Implementation

- `packages/worker-shim/`
- `containers/worker-runtimes/`

## Implementation Gaps

- App Server 0.166.0 processing read-back - Exact input correlation after lost ACK and native state recovery awaits qualification - #947

- A deployed Sandbox proves whole-home credential absence, external-authority isolation, native plugins and hooks, image defaults, and the loaded system requirements - On main, local synthetic probes do not close that proof - #120
- Host-managed Login and server-side compaction are qualified on the real Worker path, and a cross-account continuation is qualified or refused - On main, the Login path exists and that Worker-path qualification is open - #604
- Opt-in App Server provenance export runs before native work, while the rollout forest is retained either way - On main, that export refuses and has no collector - #770
- A preparation-error warning reaches the shared control refusal without a credential - On main, the control refusal does not carry that warning - #770
- Native system defaults stay enabled below the user and session layers, and the image applies them with protected precedence - On main, image qualification of that precedence is not established - #770

## Decisions

- [Control Kernel And Service Storage](../decisions/20261120-control_kernel_and_service_storage.md)

- [Four native runtime adapters](../decisions/20260929-four_native_runtime_adapters.md)
- [Codex home retained whole](../decisions/20260930-codex_home_retained_whole.md)
- [Earlier-version data](../decisions/20260930-earlier_version_data_not_carried.md)
- [Sandbox full-capability rulings](../decisions/20261001-sandbox_full_capability_rulings.md)
- [Truthful native stop classification](../decisions/20261009-truthful_native_stop_classification.md)
- [Native compaction phase hint](../decisions/20261016-native_compaction_phase_hint.md)
- [Worker runtimes upgrade](../decisions/20261031-worker_runtimes_upgrade_to_latest.md)
