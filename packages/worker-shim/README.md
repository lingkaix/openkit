# Worker Shim

`@openkit/worker-shim` provides the generic sandbox-local OpenKit worker supervisor. Its single binary, `openkit-worker-shim`, consumes the fixed Agent Execution Package, selects one adapter from a literal static registry, and preserves one shared worker-control, process-group, transcript, workspace-publication, and lineage lifecycle.

Each adapter owns exactly two operations: `prepare` builds a native launch plan from the already resolved package, and `collect` normalizes the bounded native result. Runtime-specific command, environment, image, package, result-path, or protocol overrides are not accepted. The package does not materialize executable MCP configuration; declared Skill metadata remains inert package metadata.

## Supported Adapters

- `codex`: Codex 0.144.1 through the trusted NanoCore Responses relay only. The adapter owns the fixed launch arguments, isolated `CODEX_HOME`, race-safe final-message file, and optional pinned Codex runtime-provenance capture.
- `opencode`: OpenCode 1.18.1 through the trusted NanoCore OpenAI-compatible relay only. The adapter supplies an isolated home, inline non-secret provider configuration, and fail-closed JSON-event collection.
- `pi`: Pi 0.80.7 through the exact direct `anthropic/claude-sonnet-4-5` route only. The adapter disables optional native discovery surfaces and requires correlated terminal provider and model evidence.

Every package must contain exactly one resolved LLM route. Codex and OpenCode reject direct-provider routes, while Pi rejects relay routes and every provider/model pair other than its one accepted direct pair.

## Shared Supervision

The supervisor emits `worker.ready` only after the native process starts and does not expose native argv or private turn input in that event. It retains adapter collection stdout exactly up to 16 MiB and drains native stdout and stderr while retaining diagnostic prefixes of at most 16 KiB. A bound violation fails the turn and terminates the process group.

The image launcher transfers `OPENKIT_CONTROL_TOKEN` through an anonymous file descriptor and starts the supervisor with an allowlisted environment. The native process never receives that control token or undeclared parent-process values. Turn-scoped native state is isolated below the session and removed after success, failure, or interruption.

For one clean read-write Git workspace input, the shared supervisor captures worker changes through an isolated index and publishes `workspace.patch` followed by `workspace-changes.json`. Before publication, it inspects every non-deleted changed path's exact stage-zero blob bytes from that index, rejects any blob containing an exact non-empty credential value already injected into the native child environment, and removes transient and review outputs. This is literal-value protection, not generic DLP or encoded-secret detection. It also rejects ambiguous inputs, hidden or pre-existing changes, Git filters, unsupported file modes, and incomplete publication.

## Codex Runtime Provenance

Runtime provenance is opt-in through `control.transcript.runtimeProvenance`. The Codex adapter streams primary `codex exec --json` output with backpressure and incrementally copies the stable Codex 0.144.1 rollout forest reachable from the primary thread. It writes only the fixed package-declared outputs under `/openkit/session/runtime`, subject to the declared byte and stream limits and the adapter's pinned discovery guards.

Missing root evidence is `failed`; missing, contradictory, or changing reachable evidence is `unstable`; and partial or limit-bounded evidence is `truncated`. Malformed physical frames remain explicitly indexed instead of being silently attributed. A new capture removes any prior manifest commit marker before touching raw files, and provenance-enabled failures do not copy native output into ordinary transcript diagnostics.

## Commands

- `pnpm --filter @openkit/worker-shim test`
- `pnpm --filter @openkit/worker-shim typecheck`
- `pnpm --filter @openkit/worker-shim build`
- `pnpm --filter @openkit/worker-shim lint`

## File Map

- `src/cli.ts`: shared AEP validation, worker control, process supervision, transcript, and workspace lifecycle.
- `src/adapter-registry.ts`: literal production registry and the two-operation adapter contract.
- `src/adapters/`: pinned Codex, OpenCode, and Pi adapters with adapter-local tests.
- `src/fourth-runtime.fixture.test.ts`: proof that one fixture registry entry crosses the unchanged shared supervisor.
- `snapshots/codex-0.144.1/`: minimized primary-exec and rollout JSONL fixtures pinned to Codex `rust-v0.144.1`.
