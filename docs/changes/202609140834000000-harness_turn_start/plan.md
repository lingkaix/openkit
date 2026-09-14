---
type: change-plan
status: completed
started: 2026-09-14
branch: fix/harness-turn-start-dependency-failed
---
# Harness Turn Startup

## Intent Epoch 1 — 2026-09-14

Fix GitHub issue #31 after main c6478d7: identify the pre-native Task startup failure, expose useful safe failure reasons, complete an A2-class native Codex smoke turn, and commit, push, and open one focused PR to main linking #31. Preserve A2 data and exclude #29 image fencing unless direct evidence requires it. Source: the engineer's request and https://github.com/lingkaix/openkit/issues/31.

## Owners And Method

The runtime model and `docs/specs/20260802-nanohost_runtime_and_transport.md` own Harness carriage and private runtime diagnostics. `docs/specs/20260910-persistent_worker_volumes.md` permits exclusive initialization of an empty new work slot and prohibits overwriting populated retained work. The worker shim owns Git materialization and startup; NanoCore owns refusal validation and product error projection. Use focused regressions, safe typed diagnostics, actual native smoke evidence, and diff review. No architecture or storage lifecycle addition is intended.

## Result And Evidence

OpenShell 0.0.99 creates missing read/write filesystem-policy directories before starting the shim (`prepare_read_write_path` in upstream commit 8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032, `crates/openshell-supervisor-process/src/process.rs`). A2's failed th_43 work slot was an empty plain directory without `.git`. The materializer mistook directory existence for a retained checkout and threw `Retained Git workspace baseline is unavailable.`; Harness discarded that cause as `dependency_failed`. The test-first empty-slot regression reproduced exactly that error while the other 28 workspace Git tests passed.

The materializer now initializes absent or proven-empty plain targets and still rejects populated, hidden, or incomplete retained contents without changing their bytes. Closed stage/reason diagnostics travel from the shim through Harness result validation into the existing NanoCore refusal error. Arbitrary exception messages, paths, credentials, and child output are excluded. The seed helper named by the issue exists only on A2 and already omits `last_imported_at`; no tracked repository helper exists. Image fencing remains outside this change.

Verification passed: all 211 worker-shim tests on pinned Node 24.18.0, all 21 worker-protocol tests, the 61-test focused NanoCore run followed by the expanded 51-test factory suite, dependency/NanoCore builds, NanoCore typecheck, and focused lint. Named local outputs are `temp/issue31-worker-node24.18-tests.log`, `temp/issue31-protocol-tests.log`, `temp/issue31-core-tests.log`, `temp/issue31-factory-tests.log`, `temp/issue31-build.log`, and `temp/issue31-typecheck.log`. On unpinned Node 24.21.0, one unchanged integration-client reset-after-headers test failed; the full worker suite passed on the repository pin without changing that test. Canonical ARM64 App and worker image builds and image smoke checks passed on A2 with Node 24.18.0 and Codex 0.153.4.

A2 runs candidate App `openkit/app:issue31-20adfdb` and worker manifest `sha256:96f49601b5ec3e187535b0661596f985b7a60655d4326c8a1ad2f6e2b9b6e1ba`, built from 20adfdbba51749c532a1cc8e5970f8923a576c7f. The former App container is retained stopped as `openkit-staging-before-issue31`; NanoHost was not restarted. The operator-authenticated acceptance workspace ws_10 uses the same exact public Git source as the failed ws_7 snapshot. Existing ws_7 access membership was preserved.

The source-backed Task turn `turn_ec6fc6c5-2588-4112-8b51-7eeed62ea96e_414ac2874d8a191c` in ws_10/th_45 passed image acquisition, sandbox creation, bridge opening, reference imports, workspace materialization, and native launch. Its persisted `worker.ready` reports `process.started`. A file-producing objective then failed downstream: the first Responses call succeeded, but subsequent calls reported `worker_inference_stream_failed`; native provenance reports `stream closed before response.completed`. The report file was not produced. This is an unresolved tool-bearing inference limitation, not evidence of complete coding-task acceptance.

A bounded no-tools native Task smoke with fresh storage and model gpt-6 completed through the normal authenticated Task API in the same workspace/thread: `turn_9d06f0d3-511b-470e-b0a3-d245b5fa2d2d_08d26d867b56d460`, 2026-09-14 09:02:48.325–09:02:55.401 UTC, 7076 ms, status `completed`, error null, and a persisted native assistant greeting. A separate `turn.read` confirmed that terminal result. Correlated Core records show agent session as_cf7679ad5a4088b7 emitted `worker.ready` with adapter `codex` and status `process.started` at 09:02:50.064 UTC, then `final_status` completed with stopReason completed at 09:02:53.808 UTC (`temp/a2-completed-native-events.jsonl`). Evidence: `temp/a2-greeting-turn.jsonl` and `temp/a2-completed-turn.json`. The earlier file-producing failure remains in `temp/a2-smoke-turn-with-source.jsonl` and `temp/a2-smoke-usage.json`. An intervening planning prompt was routed to Goal Mode and is excluded from native smoke evidence.

The registered consultant performed the required fresh-context direction check after primary compaction, inspected the intent, origin/main diff, failed inference evidence, and completed Task result, and returned Continue toward the focused ready PR with the downstream limitation explicit. Final direct diff inspection found no image-fencing changes, retained-byte overwrite, raw-exception publication, or stale affected package guides. Engineer review and merge remain separate from execution completion.

## Reproduction And Verification

Use the repository-pinned Node and pnpm. Run `pnpm --filter @openkit/worker-shim test` and `pnpm --filter @openkit/worker-protocol test`; the empty-slot regression must materialize the exact commit and the populated-slot cases must preserve every byte. Run the focused NanoCore Harness-record and turn-executor-factory tests to verify safe refusal validation and the rendered startup reason. Build matching App and worker images, select the resulting worker manifest in the runtime agent configuration, and launch a fresh-storage gpt-6 Task against an exact Git source. A no-tools greeting objective must reach a native assistant response and terminal completion. A file-producing objective additionally exercises the unresolved inference continuation path and must not be represented as passing by this evidence.
