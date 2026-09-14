---
type: change-plan
status: in-progress
started: 2026-09-14
branch: fix/harness-turn-start-dependency-failed
---
# Harness Turn Startup

## Intent Epoch 1 — 2026-09-14

Fix GitHub issue #31 after main c6478d7: identify the pre-native Task startup failure, expose useful safe failure reasons, complete an A2-class native Codex smoke turn, and commit, push, and open one focused PR to main linking #31. Preserve A2 data and exclude #29 image fencing unless direct evidence requires it. Source: the engineer's request and https://github.com/lingkaix/openkit/issues/31.

## Owners And Method

The runtime model and `docs/specs/20260802-nanohost_runtime_and_transport.md` own Harness carriage and private runtime diagnostics. `docs/specs/20260910-persistent_worker_volumes.md` permits exclusive initialization of an empty new work slot and prohibits overwriting populated retained work. The worker shim owns Git materialization and startup; NanoCore owns refusal validation and product error projection. Use focused regressions, safe typed diagnostics, actual native smoke evidence, and diff review. No architecture or storage lifecycle addition is intended.

## Checkpoint

A2's failed th_43 snapshot selects an exact Git source and work slot. Its retained target is an empty plain directory with no `.git`. The shim currently treats existence as a populated retained checkout. The new empty-slot regression fails with `Retained Git workspace baseline is unavailable.`; the other 28 workspace Git tests pass. The harness catches this exception and discards everything except `dependency_failed`. Installed dependencies with the unchanged frozen lockfile; local Node is 24.21.0 versus the repository's 24.18.0 pin.

Next action: permit initial materialization only into an absent or proven empty plain target, retain rejection of hidden/populated/incomplete contents, and propagate closed safe startup diagnostics. Expected observation: the empty-slot regression passes without weakening retained-content checks. Then verify the actual A2-class native path and inspect the final diff before publication.

The seed helper named by the issue exists only on A2 and already omits `last_imported_at`; no tracked repository helper exists. Image fencing remains outside this change.

The pinned upstream OpenShell `crates/openshell-supervisor-process/src/process.rs` at 8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032 creates missing read/write policy directories in `prepare_read_write_path` before execution. This explains the empty target observed on A2. The corrected materializer initializes only absent/empty plain targets. Closed startup diagnostics now flow through Harness result validation to the existing NanoCore error message. Focused evidence: initial empty-slot regression failed; 115 worker checks then passed; the additional workspace diagnostic test brings CLI coverage to 75 passing tests. NanoCore refusal/dispatch tests passed (61), and the additional error-message case brings the factory suite to 51 passing tests. Dependency and NanoCore builds passed; focused typecheck and lint passed. Actual A2 smoke remains pending.
