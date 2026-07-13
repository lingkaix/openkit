# Codex 0.144.1 Runtime Snapshots

These minimized JSONL snapshots pin the runtime provenance field shapes defined by Codex release `rust-v0.144.1` at commit `44918ea10c0f99151c6710411b4322c2f5c96bea`. The deterministic identifiers and event values are synthetic test data, not captured user or model output.

- `exec-primary.jsonl` preserves the root thread and native `spawn_agent` lifecycle edge from the primary exec stream.
- `rollout-root.jsonl` preserves the root session and turn metadata.
- `rollout-child-0001.jsonl` preserves the child thread, parent link, role, nickname, depth, and turn metadata.
- `metadata.json` records the pinned upstream release and fixture digests.

The files intentionally omit model output, usage, and unrelated event variants that are not needed to verify byte preservation and root-to-child lineage.
