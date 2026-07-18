# Worker Shim

`@openkit/worker-shim` provides the sandbox-local OpenKit Codex worker entrypoint.

The package supplies one binary:

- `openkit-codex-shim`: supervises the Codex process, talks directly to NanoCore worker-control routes, and writes OpenKit transcript records.

The implementation covers the durable transcript contract under `/openkit/session` and direct heartbeat and command handling.

After the Codex child starts, the shim tolerates a bounded NanoCore outage. One memory-only 256-bit process key is committed by hash on heartbeat sequence zero; after a NanoCore restart, the same shim presents that key with the exact next heartbeat sequence before replaying the blocked request. Restarting the shim creates a new key and therefore fails closed instead of claiming the old lease.

The image launcher transfers `OPENKIT_CONTROL_TOKEN` to the shim through an anonymous file descriptor and starts the supervisor with a clean allowlisted environment. The Codex child process never receives that token or undeclared parent-process values; it receives only the OpenShell `OPENKIT_WORKER_INFERENCE_TOKEN` placeholder in addition to the shared non-secret runtime allowlist.

For one clean read-write Git workspace input, the Codex shim also captures worker changes through an isolated index and publishes `workspace.patch` followed by `workspace-changes.json` under the session directory. The shim rejects ambiguous inputs, hidden or pre-existing workspace changes, Git filters, unsupported file modes, and incomplete output publication so NanoCore receives one reviewable snapshot with explicit worker lineage.

## Runtime Provenance

Runtime provenance is opt-in through the AEP `control.transcript.runtimeProvenance` declaration. The NanoCore projection fixes the restricted outputs at `/openkit/session/runtime/raw`, `/openkit/session/runtime/raw-streams.json`, and `/openkit/session/runtime/native-origin-index.jsonl` and supplies the declared 256 MiB total-byte and 64-stream limits.

When declared, the Codex shim streams primary `codex exec --json` stdout to `raw/stream-0000.jsonl` with backpressure, retains only bounded stdout and stderr diagnostic prefixes, and incrementally copies the stable Codex 0.144.1 rollout forest reachable from the primary thread. It writes synthetic stream names, exact byte and frame digests, native-origin coordinates, and capture status without exposing native ids through ordinary transcript files or filenames.

Missing root evidence is retained as `failed`; missing, contradictory, or changing reachable evidence is `unstable`; and partial or limit-bounded evidence is `truncated`. Malformed physical frames remain explicitly indexed as `malformed` instead of being silently attributed. Without the AEP declaration, no runtime provenance files are created and the existing final assistant message, worker lifecycle transcript, and workspace publication behavior remain unchanged.

The Codex adapter also applies implementation hard limits of 256 rollout candidates, 2,048 scanned directory entries, 4,096 retained physical frames, 512 bytes per repeated native index value, and 128 bytes per event kind. Reaching a discovery or frame guard stops further work, and an oversized repeated value becomes unattributed; either condition marks the capture incomplete while preserving a one-to-one index entry for every retained frame. A new capture removes any prior manifest commit marker before touching raw files, and provenance-enabled failures never copy runtime-native process output into ordinary transcript diagnostics.

## Commands

- `pnpm --filter @openkit/worker-shim test`
- `pnpm --filter @openkit/worker-shim typecheck`
- `pnpm --filter @openkit/worker-shim build`
- `pnpm --filter @openkit/worker-shim lint`

## File Map

- `src/`: worker shim, direct worker-control client, and tests.
- `snapshots/codex-0.144.1/`: minimized primary-exec and rollout JSONL fixtures pinned to Codex `rust-v0.144.1`.
