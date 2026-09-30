# Pi Runtime Host

`@openkit/pi-runtime-host` is the dedicated Pi SDK host process that the [Pi Worker Adapter](../../docs/specs/20260716-pi_worker_adapter.md) asks the shared Harness to supervise. One host process serves exactly one AgentSession: it holds one resident native Pi conversation, prompts it once per Turn, and translates its SDK events into one settled outcome. User packages, Extensions, Skills, and prompt templates run in this process, never in the Harness.

The package owns the private host control channel, exact session identity and resume proof, the native model descriptor and credential carriers, host-managed OpenKit MCP through `pi-mcp-adapter`, output correlation, interrupt, and close. It does not own process supervision, the six Harness operations, AgentSession lifecycle, credential minting, `harness.drain`, stdout and stderr diagnostic bounds, or product state; the Harness and the shim-side Pi adapter own those under [Worker Control Protocol](../../docs/specs/20260703-worker_control_protocol.md#harness-control-operations). The shim adapter drives this host over the channel below and is the only client.

## Layout

- `src/bin/openkit-pi-runtime-host.ts`: the zero-argument process entry. It sets `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, and `PI_TELEMETRY=0`, and serves the channel on file descriptor 3.
- `src/channel.ts`: the request schema, response and event types, frame bounds, the bounded line reader, and secret redaction.
- `src/host.ts`: `PiRuntimeHost`, the state machine behind the channel.
- `src/identity.ts`: session path allocation, the canonical restricted handle, its digest, and the header proof.
- `src/outcome.ts`: terminal correlation of one prompt's events into one outcome, with the 16 MiB bound on the whole final assistant content.
- `src/host-managed-mcp.ts`: the jiti loader and local types for `pi-mcp-adapter/host-managed`.
- `src/test-support/`: synthetic inference and capability endpoints and a host process client for tests.

Relative imports carry the `.ts` extension, which the build rewrites to `.js`, so tests start the source entry directly under Node type stripping.

## Private Control Channel

The Harness spawns the host with no arguments and passes a private socket pair as file descriptor 3. Frames are UTF-8 JSON objects, one per line. User Extensions may write anything to stdout or stderr, and neither stream carries a frame. Every request is `{id,op,...fields}`. A successful response is `{id,ok:true,result}`; `configure` returns `{}`. Every unsolicited event is `{event:<name>,...fields}`. Responses and events can interleave and are correlated by request id and Turn id, not arrival position. Each request with a usable `id` gets exactly one response. Requests are not queued behind one another: an `interrupt`, `inspect`, or `close` is served while a Turn prepares or runs. An inbound line is limited to 8 MiB; an outbound frame is limited to six times the 16 MiB result bound plus 64 KiB. Every outbound frame has both loopback credentials replaced by `[redacted]` before it is written. This channel is not a product protocol and carries no Pi RPC shape; `src/channel.ts` is its executable shape.

Requests, validated exactly with unknown fields rejected:

- `open`: `agentDir`, `capabilityBaseUrl`, `capabilityCredential`, `inferenceBaseUrl`, `inferenceCredential`, `mcpServers` (unique OpenKit server ids, at most 64), `model`, `resume` (`{ handle }` with the exact stored handle text, or `null`), `stateRoot`, and `workingDirectory`. Paths are absolute. Both base URLs are `http://127.0.0.1` URLs without user info. Both credentials are 43-character unpadded base64url. The result is `{ nativeHandle }`. A `close` or channel loss that arrives while `open` is still preparing wins: the `open` is refused with `invalid_state`, no binding is adopted, and the fresh session directory it allocated is removed while still empty.
- `inspect`: repeats the identity proof without launching work. The result is `{ nativeHandle, state: "idle" | "active" | "failed", turnId }`. A failed proof answers `identity_failed`, fences the binding, and stops an active Turn, which then settles as failed.
- `configure`: `{ model }` replaces the admitted model descriptor for the next Turn and returns `{}`. It is refused with `busy` while a Turn is active.
- `turn`: `{ prompt, turnId }` with a prompt of at most 4 MiB. The result `{ state: "started" }` is sent as soon as the Turn is admitted, before any setup, so later control requests are never blocked by it. The outcome always follows as exactly one `turn_settled` event, including when setup or identity proof fails.
- `interrupt`: `{ turnId }` cancels that Turn at whatever stage it is in and answers after it settles with `{ outcome }`, the settled status, or `not_active` when that Turn is not running. It never closes the session.
- `close`: stops any Turn the same way, closes the MCP connection, disposes the SDK session, answers `{ nativeHandle, state: "closed" }`, and exits with status 0. The session file and every other retained byte stay in place.

A model descriptor is `{ contextWindow, inputModalities, maxOutputTokens, modelId, reasoning }`, where `inputModalities` contains `text` and optionally `image`, and `maxOutputTokens` does not exceed `contextWindow`.

Admission by host state (`close` is also accepted in every state before closing):

| State | Entered by | `inspect` | `configure` | `turn` | `interrupt` |
| --- | --- | --- | --- | --- | --- |
| unopened, opening | start, `open` in progress | `invalid_state` | `invalid_state` | `invalid_state` | `not_active` |
| open | successful `open`, or a settled Turn of an established conversation | proof | accepted | accepted | `not_active` |
| active | admitted `turn` | proof | `busy` | `busy` | cancels the named Turn |
| failed | failed `open`, failed identity proof, failed setup, or a first Turn that did not complete | `{ state: "failed" }` without promotion, or `invalid_state` after a failed `open` | `invalid_state` | `invalid_state` | cancels a Turn an inspection fenced while it still settles, otherwise `not_active` |
| closing, closed | `close` or channel loss | `invalid_state` | `invalid_state` | `invalid_state` | `invalid_state` |

`nativeHandle` is authority only in the `ready` state. `{ state: "ready", handle, digest }` names a proved established conversation: a resumed one from `open` on, or a new one only after its first Turn completed and its file was proved. `{ state: "pending" }` means a new conversation that has not completed a Turn and has no session file. `{ state: "unknown" }` means a proof failed, or that a session file exists for a conversation that never completed a Turn; it grants nothing, and the file is preserved rather than repaired or removed. A new conversation whose first Turn did not complete is non-reusable, and the host fences it for exact close. A failed or interrupted later Turn keeps the established handle unchanged. `handle` is the canonical text `{"cwd":…,"path":…,"sessionId":…}` and `digest` is the lowercase hexadecimal SHA-256 of exactly those UTF-8 bytes.

Error responses are `{ id, ok: false, error: { code, message } }` with `id` null when the line had no usable id. The codes are `invalid_request`, `invalid_state`, `identity_failed`, `setup_failed` (from `open` only), and `busy`. Messages never carry file content or credential values.

Events:

- `native`: `{ turnId, data }` forwards one SDK session event of that Turn, except `message_update` streaming deltas. An event whose JSON exceeds 4 MiB is sent as `native_omitted` with its `type` and byte size instead.
- `turn_settled`: `{ turnId, outcome, nativeHandle, compactionEntryIds }`. `outcome` is `{ status: "completed", assistantText }` or `{ status: "failed" | "interrupted", reason }`. The failure reasons are `pi-setup-failed`, `pi-identity-failed`, `pi-prompt-failed`, `pi-terminal-correlation-failed`, `pi-route-mismatch`, `pi-output-malformed`, `pi-output-too-large`, and `pi-final-message-empty`; interruption is `worker-interrupted`. A failed identity proof after the prompt turns any outcome into `pi-identity-failed` with an `unknown` handle. `compactionEntryIds` lists the compaction entries this prompt added to the session graph.
- `ui_unsupported`: `{ method, turnId }` records one Extension UI request the headless host cannot serve. Every dialog (`select`, `confirm`, `input`, `editor`, `custom`) is reported on each call and resolves as cancelled, with `confirm` returning `false`. Every terminal-only method (`notify`, `setStatus`, `setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`, `setHiddenThinkingLabel`, `setWidget`, `setFooter`, `setHeader`, `setTitle`, `pasteToEditor`, `setEditorText`, `addAutocompleteProvider`, `setEditorComponent`, `onTerminalInput`, `setTheme`, `setToolsExpanded`) and a loaded keyboard shortcut declaration (`registerShortcut`) are reported once per method and then have no visible effect. Read-only accessors such as `theme` and `getEditorText` stay available.
- `extension_error`: `{ message }` reports an Extension load or runtime error.

### Cancellation And Setup Ordering

The SDK session, the resource loader, and the MCP connection are created during the first Turn, after `started`. Setup re-proves identity before every prompt, including on a resident session and before a changed model is applied. An interrupt, `close`, or channel loss cancels a Turn at each stage: during MCP setup it closes the adapter, which aborts a pending `initialize`, and every later setup step checks for cancellation and disposes what it created; during Extension input hooks or pre-run compaction, the SDK's preflight callback refuses to start the agent run and the host's own Extension cancels compaction, reading the current Turn on every call rather than the Turn that created the resident session; during the run, native `abort()` stops it. Only then does the Turn settle, and only then does `interrupt` or `close` answer. A setup or identity failure settles the Turn as failed and fences the binding.

Besides the preflight callback and the compaction hook, the host has a run-start gate. The pinned agent loop checks an existing run's abort signal after its tool-call handlers and before tool execution. An Extension can also trigger a new native run with a fresh signal, so the resident host-control Extension checks the current Turn at every `agent_start` and aborts a run when that Turn is absent, cancelled, fenced, or no longer active. These checks stop new work; they do not prove rollback of an already-dispatched external effect.

### Channel Loss

End of file or an error on the channel, and `SIGTERM`, stop the host the same way `close` does, without a response, and the process exits with status 1. The host never retries a lost channel.

### Shim Adapter Responsibilities

The shim-side Pi adapter verifies the predecessor locator and digest before it sends `resume.handle`, retains the exact returned handle bytes outside disposable control storage, enforces the first-Turn reuse gate from the `turn_settled` evidence, and consumes `native` events only inside the adapter.

## Session Identity

A new conversation gets a fresh absent file at `<stateRoot>/sessions/binding-XXXXXX/session.jsonl`. A resumed conversation must be the exact file the handle names: a canonical handle whose path is a normalized strict child of the state root, whose recorded cwd is the admitted working directory, and whose file is a regular non-symlinked file under real directories with a nonempty first line recording `type: "session"`, the handle's session id, and that cwd. Every missing, empty, malformed, symlinked, wrong-id, wrong-cwd, non-canonical, or outside-root case fails `open` with `identity_failed` before any work. The host never scans for, selects, truncates, or replaces another file, and it adds no inode or history tracker. The SDK session is opened with `SessionManager.open(path, dirname(path), workingDirectory)`, and a resumed session whose id differs from the handle fails.

## Model And Credentials

The host builds a `ModelRuntime` over an `InMemoryCredentialStore` with `modelsPath: null`, `refreshOnCreate: false`, and `allowModelNetwork: false`, so it never reads `<agentDir>/models.json` or `<agentDir>/auth.json` and never refreshes a catalog. It registers one provider alias, `openkit-worker-inference`, with `api: "openai-completions"`, the supplied inference base URL, and exactly the admitted model, then calls `setRuntimeApiKey` with the inference loopback credential. That is the inference carrier: the SDK sends it as `Authorization: Bearer`, and it is not part of the descriptor, the environment, argv, the session file, or any agent directory file. A `configure` re-registers the alias with the new model and selects it with `setModel` before the next prompt, on the same conversation. Collection requires the settled assistant message to name that alias and that Turn's model.

The capability loopback credential is carried only in the `Authorization` header that each `StreamableHTTPClientTransport` sends to `<capabilityBaseUrl>/mcp/<serverId>`.

The host sets `PI_CODING_AGENT_DIR` to the admitted agent directory so SDK and adapter defaults that do not take an explicit directory agree with it. Settings are created with `projectTrusted: false`, and the resource loader runs with an explicit agent directory, `noThemes`, `noContextFiles`, and system-prompt overrides that discard any discovered `SYSTEM.md` and `APPEND_SYSTEM.md`, so user packages, Extensions, Skills, and prompt templates load through Pi's normal settings while project resources, user themes, `AGENTS.md` context files, and retained system-prompt files in the agent or project directory stay off. `noContextFiles` alone covers only the context files, which is why the overrides are needed; the retained files themselves are left in place. Because the host offers a UI context, `ctx.hasUI` is true for Extensions; the host therefore initializes the built-in `dark` theme without a watcher, as every Pi mode does, so Extensions that format output do not fail.

## OpenKit MCP

The host-managed entry of `pi-mcp-adapter` is created at the first Turn, after the Harness has bound that Turn and before its prompt, because the capability plane refuses every request while no Turn is bound. `ready()` connects each supplied server once and freezes the tool catalog, and the adapter never reconnects. The host declares that this runtime does not list tools again at Turn start: a changed supply is a setup change that the Harness serves with a successor host resuming the same session file. A second Turn's calls reuse the same connection after the plane cut its streams and refused requests at the barrier.

The adapter asks for approval of every call on the shared Extension event bus. The host answers `allow_once` for the OpenKit servers it was given, because authorization of those calls belongs to NanoCore's Gateway behind the capability plane, which returns `capability_denied` or a pending request through the tool result. The host leaves requests for other server names unclaimed, since they come from a user's own adapter configuration and keep that configuration's behavior. Native permission prompts from Extensions resolve as cancelled and are reported through `ui_unsupported`; the host never selects an allow option.

## Probe Results

These results were established against the pinned combination and are asserted by the tests named in parentheses.

- A new conversation reports `pending` at `open`. Pi writes the session file at the first assistant message, so after a completed first Turn the handle becomes `ready` in its `turn_settled` event and stays identical afterwards (`runs two Turns on one conversation…`); after a first Turn that did not complete, the file exists but the handle is not `ready` (`grants no ready authority…`).
- The inference carrier is `ModelRuntime.setRuntimeApiKey` over an in-memory credential store; the capability carrier is the transport header. Neither value appears in argv, the environment an Extension sees, the model object an Extension sees, stdout, stderr, channel frames, the session file, or agent directory files, and retained `auth.json` and `models.json` entries for the alias are ignored (`keeps both loopback credentials out of…`).
- `@modelcontextprotocol/client` 2.0.0 negotiates protocol version `2025-11-25` over Streamable HTTP and opens one standalone GET stream. When the plane cuts that stream and refuses requests between Turns, the next Turn's `tools/call` succeeds on the same connection with no second `initialize` or `tools/list` (`runs two Turns on one conversation…`).
- A user's in-Sandbox MCP servers use the ordinary adapter's own configuration file, `<agentDir>/mcp-adapter.json`, when the user installs `pi-mcp-adapter` as a Pi package; that server is called through the adapter's `mcp` proxy tool with one client beside the OpenKit connection (`serves a user's in-Sandbox MCP server…`). By the pinned adapter's source and README, it does not read Pi's `mcp.json`, it also reads `~/.config/mcp/mcp.json` and project `.mcp.json` or `.pi/mcp-adapter.json`, and it blocks project-defined servers while the project is untrusted. The pinned Pi release has no built-in MCP and the host-managed entry reads no configuration file, so one server never has two clients. The image should write user MCP configuration to `<agentDir>/mcp-adapter.json`.
- Pi compacts inside a prompt when a response reports near-full context. The compaction entry is appended without an `entry_appended` event, so the host reports the compaction entries that were absent before the prompt (`records the compaction identities…`).
- A prompt that an Extension command handles entirely runs no agent turn and therefore settles as `pi-terminal-correlation-failed`.
- While Extension input hooks run, the pinned SDK has no active agent run, so `abort()` alone does not stop the prompt that follows and `_runAgentPrompt()` resets its abort flag. The `preflightResult` callback of `prompt()` is called synchronously just before that run starts, and a throw from it prevents the run (`stops an interrupt during Extension input hooks…`).
- The pinned adapter's `close()` aborts a `ready()` still waiting on `initialize` (`cancels a held first-Turn MCP initialize…`).
- Pre-run compaction runs before `preflightResult` and can send its own summarization request, so only the `session_before_compact` hook stops it for an interrupted Turn (`cancels the pre-run compaction of an interrupted later Turn`). The pinned agent loop checks an existing run's abort signal after its tool-call handlers and before tool execution (`blocks the tool call of an interrupted later Turn…`). An Extension can also trigger a new native run with a fresh signal, so the resident host-control Extension checks the current Turn at every `agent_start` and aborts a run when that Turn is absent, cancelled, fenced, or no longer active (`fences a native run an Extension starts after an interrupt`, `fences a native run an Extension starts while no Turn is active`). These checks stop new work; they do not prove rollback of an already-dispatched external effect.

## Pins

- `@earendil-works/pi-coding-agent` 0.87.1 (gitHead `f07218c4`), with `@earendil-works/pi-ai` and `@earendil-works/pi-tui` at 0.87.1 so the adapter's peers resolve to the same copies. `pi-mcp-adapter` 3.3.0 accepts `@earendil-works/pi-ai` only up to `^0.87.0`, so 0.87.1 is the highest compatible Pi pin.
- `pi-mcp-adapter` 3.3.0. Its npm gitHead `9a747ce9` is the examined commit `b33382ac` plus one release commit that changes only `CHANGELOG.md`, `package.json`, and `package-lock.json`. All 239 tarball files match the source at that commit, the 87 generated `dist` files match byte for byte after a rebuild, and the package has no install scripts.
- `@modelcontextprotocol/client` 2.0.0, the exact version `pi-mcp-adapter` uses, so the transport type matches.
- `jiti` 2.7.0, the version Pi itself uses. `pi-mcp-adapter/host-managed` is published only as TypeScript source, which Node refuses to strip under `node_modules` and which the repository's compiler settings would type-check, so the host loads it through jiti and types the narrow surface locally in `src/host-managed-mcp.ts`. The tests exercise the real module, which is what proves those types match.

There is no TypeScript package cookbook under `docs/cookbooks/`, so this package mirrors the configuration of `@openkit/worker-shim`.

## Commands

- `pnpm --filter @openkit/pi-runtime-host test`
- `pnpm --filter @openkit/pi-runtime-host typecheck`
- `pnpm --filter @openkit/pi-runtime-host build`
- `pnpm --filter @openkit/pi-runtime-host lint`

The tests start the real host process against the pinned SDK and adapter with synthetic loopback inference and capability endpoints; they use no network and no live provider.
