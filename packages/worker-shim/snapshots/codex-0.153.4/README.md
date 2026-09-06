# Codex 0.153.4 Runtime Snapshots

These minimized JSONL snapshots pin the runtime provenance field shapes defined by Codex release `rust-v0.153.4` at commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`. The deterministic identifiers and event values are synthetic test data, not captured user or model output.

- `exec-primary.jsonl` is the bounded primary `codex exec --json` stream.
- `rollout-root.jsonl` is the reachable root rollout.
- `rollout-child-0001.jsonl` is one reachable child rollout.
- `metadata.json` records the pinned upstream release and fixture digests.
