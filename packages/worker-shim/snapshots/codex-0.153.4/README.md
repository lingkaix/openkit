# Codex 0.153.4 Runtime Snapshots

These minimized JSONL snapshots pin the runtime provenance field shapes defined by Codex release `rust-v0.153.4` at commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`. The deterministic identifiers and event values are synthetic test data, not captured user or model output.

- `exec-primary.jsonl` is the bounded primary `codex exec --json` stream.
- `rollout-root.jsonl` is the reachable root rollout.
- `rollout-child-0001.jsonl` is one reachable child rollout.
- `metadata.json` records the pinned upstream release and fixture digests.

These historical `0.153.4` exec and rollout fixtures are retained for `src/codex-runtime-provenance.test.ts` to test the provenance parser's former exec layout. They are not the deployed runtime pin or App Server provenance qualification. The resident Codex App Server v2 adapter is owned by [Codex Worker Adapter](../../../../docs/specs/20260716-codex_worker_adapter.md), and its deployment pin is recorded in [the runtime version manifest](../../../../containers/worker-runtimes/versions.json).
