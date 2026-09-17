# Codex 0.153.4 Runtime Snapshots

These minimized JSONL snapshots pin the runtime provenance field shapes defined by Codex release `rust-v0.153.4` at commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`. The deterministic identifiers and event values are synthetic test data, not captured user or model output.

- `exec-primary.jsonl` is the bounded primary `codex exec --json` stream.
- `rollout-root.jsonl` is the reachable root rollout.
- `rollout-child-0001.jsonl` is one reachable child rollout.
- `metadata.json` records the pinned upstream release and fixture digests.

`unknown-model-fallback-prompt.md` derives from the exact upstream `codex-rs/models-manager/prompt.md` at the same pin. With the adapter's fixed startup defaults, Codex removes checklist instructions using `codex-rs/core/src/context/update_plan_instructions.rs`; for this pinned prompt that removes precisely the `## Planning` and ``## `update_plan` `` sections through the next H1/H2 heading or end of file, preserving all remaining bytes. Custom catalogs bypass that native filtering, so the asset contains the already-filtered text. It is not user-authored instruction supply or a captured model response. `metadata.json` records upstream and derived SHA-256 values and the transformation. Preserve these bytes on packaging and rederive them from source when updating the Codex pin; compare the resulting native request instructions against the no-catalog baseline.

`bundled-models.json` is the exact upstream `codex-rs/models-manager/models.json` at the same pin. The native custom catalog replaces its bundled catalog, so the adapter retains every bundled entry alongside the unknown selected model to preserve sub-agent model choices. The repository formatter excludes these upstream bytes, as it does the models.dev snapshot. Update the asset and metadata digest together with the Codex pin.
