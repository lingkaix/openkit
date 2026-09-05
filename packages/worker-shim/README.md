# Worker Shim

`@openkit/worker-shim` provides the generic sandbox-local OpenKit worker supervisor. Its single zero-argument binary, `openkit-worker-shim`, runs the shared Codex Harness used by NanoHost, selects one adapter from a literal static registry, and preserves one shared worker-control, process-group, transcript, workspace-publication, and lineage lifecycle.

Before native process launch, the shim accepts the stock Supervisor connection only on its image-owned `127.0.0.1:17891` binding and establishes one standard HTTP/2 client session. That session exposes only `/worker-control/*`, `/inference/*`, and `/capabilities/*`; the shared Harness uses only credential-free `/worker-control/harness/poll` and `/worker-control/harness/result`, while each active Turn binds distinct worker-control, inference, and selected-MCP capability route tokens and clears them at its terminal barrier. A separate loopback-only HTTP/1 listener at `127.0.0.1:17892` admits exact authenticated native `POST /inference/*` and enabled `POST /capabilities/mcp/*` requests only after that H2 session is ready, streams them through the existing route family without retry, and closes with the same Integration client. The worker receives no NanoCore, Gateway, upstream MCP, or caller-selected transport address.

The no-argument Harness writes the fixed value-free `OPENKIT_WORKER_SHIM_ENTRY_V1\n` marker exactly once after its loopback listener is installed and before it waits for the stock bridge connection. NanoHost consumes that marker only as bootstrap-entry evidence; it is not authentication, native-child start, terminal, transcript, or product state.

The adapter registry has two closed modes. A `bounded-turn` adapter owns only `prepare` and `collect`; the Codex `session-continuity` adapter owns only `openSession`, `prepareTurn`, `collectTurn`, `inspectSession`, and `closeSession`, retaining one restricted native handle inside its AgentSession-private root. Runtime-specific command, environment, image, package, result-path, or protocol overrides are not accepted. The package does not materialize upstream MCP commands, endpoints, or credentials; the Codex adapter derives only fixed loopback URLs for exact selected server ids, and declared Skill metadata remains inert package metadata.

## Supported Adapters

- `codex`: Codex 0.153.4 through the trusted NanoCore Responses relay only. This is the sole `session-continuity` adapter; it owns the fixed first-launch `--cd` arguments, exact-thread-UUID resume arguments without `--cd` because the Harness owns process cwd, AgentSession-private `CODEX_HOME`, restricted handle proof, race-safe final-message file, and optional pinned runtime-provenance capture.
- `opencode`: OpenCode 1.18.1 through the trusted NanoCore OpenAI-compatible relay only. This remains a `bounded-turn` adapter with an isolated home, inline non-secret provider configuration, and fail-closed JSON-event collection.
- `pi`: Pi 0.85.1 through the exact direct `anthropic/claude-sonnet-4-5` route only. This remains a `bounded-turn` adapter that disables optional native discovery surfaces and requires correlated terminal provider and model evidence.

Every package must contain exactly one resolved LLM route. Codex and OpenCode reject direct-provider routes, while Pi rejects relay routes and every provider/model pair other than its one accepted direct pair.

## Shared Supervision

The no-argument Harness keeps one Integration client and one process-group supervisor alive, admits at most eight open Codex AgentSessions and one active Turn, and starts each Turn in a fresh native process. `session.open` creates one `/openkit/sessions/<agent-session-id>` namespace with the exact `config/package.json` destination and `context` root. `turn.start` accepts only those exact references for its AgentSession, and the Harness reports the AgentSession idle only after both Turn input slots are removed; the next imports recreate only their closed paths beneath the retained parent namespace. Exact `session.close` removes that namespace without disturbing a sibling AgentSession. The Harness returns `turn.start` after the supervised child and route binding are live, uses the same supervisor for the mode-exclusive private interrupt, collects the first exact Codex thread UUID as the restricted handle, and resumes that UUID in later processes without sharing state with sibling AgentSessions. It retains adapter collection stdout exactly up to 16 MiB and drains native stdout and stderr while retaining diagnostic prefixes of at most 16 KiB. A bound violation fails the Turn and terminates the process group; after TERM-to-KILL escalation, an addressable process group remains unresolved and cannot produce a successful final status or physical completion barrier.

The NanoHost Harness bootstrap supplies no arguments, environment values, or stdin bytes. Three raw Turn route tokens arrive only inside the dispatch-time private `turn.start` operation, are bound to the existing Integration route owners for that Turn, and are cleared at its terminal barrier; durable records retain only hashes. The native process never receives the worker-control token or undeclared parent-process values; the selected inference adapter receives only the inference token, and Codex receives the capability token only when exact selected MCP supply enables its routes. No route token enters native argv, diagnostics, transcript, or ordinary output. Turn-local output is removed after success, failure, or interruption, while the restricted Codex handle persists only until exact `session.close`.

For one read-write Git workspace input, the shared supervisor validates the closed AEP source projection, rejects credential-bearing or non-HTTPS URLs before contact, creates a fresh worktree below the declared Workspace root, fetches the exact commit with the image-owned Git client, checks out detached `HEAD`, and proves a clean exact base before native start. Failure removes the partial target, and a later Turn rematerializes the worktree without deleting AgentSession-private native state. After native completion, the supervisor captures worker changes through an isolated index and publishes `workspace.patch` followed by `workspace-changes.json`. Before publication, it inspects every non-deleted changed path's exact stage-zero blob bytes from that index, rejects any blob containing an exact non-empty credential value already injected into the native child environment, and removes transient and review outputs. This is literal-value protection, not generic DLP or encoded-secret detection. It also rejects ambiguous inputs, hidden or pre-existing changes, Git filters, unsupported file modes, and incomplete publication.

## Codex Runtime Provenance

Runtime provenance is opt-in through `control.transcript.runtimeProvenance`. The Codex adapter streams primary `codex exec --json` output with backpressure and incrementally copies the stable Codex 0.153.4 rollout forest reachable from the primary thread. It writes only the fixed package-declared outputs under `/openkit/session/runtime`, subject to the declared byte and stream limits and the adapter's pinned discovery guards.

Missing root evidence is `failed`; missing, contradictory, or changing reachable evidence is `unstable`; and partial or limit-bounded evidence is `truncated`. Malformed physical frames remain explicitly indexed instead of being silently attributed. A new capture removes any prior manifest commit marker before touching raw files, and provenance-enabled failures do not copy native output into ordinary transcript diagnostics.

## Commands

- `pnpm --filter @openkit/worker-shim test`
- `pnpm --filter @openkit/worker-shim typecheck`
- `pnpm --filter @openkit/worker-shim build`
- `pnpm --filter @openkit/worker-shim lint`

## File Map

- `src/harness.ts`: one concrete multi-AgentSession Codex Harness, six fixed operations, private pull loop, and mode-exclusive interruption.
- `src/cli.ts`: shared AEP validation, process supervision, transcript, and workspace lifecycle used by each admitted Turn.
- `src/integration-client.ts`: fixed loopback listener, standard HTTP/2 client, credential-free private Harness carriage, and Turn-scoped credential-separated route boundary.
- `src/adapter-registry.ts`: literal production registry and the two closed adapter-mode contracts.
- `src/adapters/`: pinned Codex, OpenCode, and Pi adapters with adapter-local tests.
- `src/fourth-runtime.fixture.test.ts`: proof that one fixture registry entry crosses the unchanged shared supervisor.
- `snapshots/codex-0.153.4/`: minimized primary-exec and rollout JSONL fixtures pinned to Codex `rust-v0.153.4`.
