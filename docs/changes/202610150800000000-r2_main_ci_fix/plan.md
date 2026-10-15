---
type: change-plan
status: in-progress
date: "2026-10-15"
branch: v010/r2-main-ci-fix
---
# R2 Main CI Corrections

## Intent Revision 1

Source: the coordinator's urgent correction dispatch after main CI run 38697916406 failed on `06b0d27c`. Reproduce the protocol guarded coverage failure and built-artifact Worker MCP smoke failure from current main. Fix each cause separately without lowering thresholds, weakening assertions or skipping checks. If pre-Turn retrieval has a product defect, add a regression that fails before its correction. Run the complete CI-equivalent L0-L2 and L5 commands. Commit each cause separately with the previously requested identity. Do not push, merge or contact deployment hosts.

## Owners And Boundaries

[Core Protocol](../../core/protocol.md) owns qualified references. [Retrieval Kernel](../../specs/20261014-retrieval_kernel.md) owns supervised kernel supply and pre-Turn retrieval. [Test Strategy](../../specs/20260529-test_strategy.md), [Verification Instruments](../../verification-instruments.md) and [Toolchain](../../toolchain.md) own deciding checks and their environments. This correction restores their existing requirements and changes no design, durable format, authorization or release-publication job.

## Checkpoint

The branch starts at origin/main `06b0d27c`. The cleaned CI log reports protocol branch coverage 56.71%, below the unchanged 60% threshold. The L5 task build lists only six TypeScript packages and no kernel build. Hypothesis: missing parser regressions explain coverage, and missing kernel supply explains the built Task refusal. Expected observations: the existing guarded protocol coverage command fails its threshold; the unchanged L5 command fails its Task request when the generated kernel binary is temporarily set aside. A different failure or a retained binary build would defeat the second hypothesis. The original generated binary is retained and restored after the probe. Logs stay under this task's temporary evidence directory or `/tmp`.

Next action: reproduce both failures, inspect each deciding path, then add the smallest owner-derived regression and correction for each cause. Full validation uses `pnpm -w verify:l0-l2` and `pnpm -w test:smoke`, as CI does.

## Observed Causes And First Correction

The exact exported `coveredSuite` recipe from `scripts/release-tests.mjs` reproduced the guard failure: 210 passing protocol tests, 56.71% branches, exit 1. The new object-reference parser and current-kind validators had no direct protocol regression. Forty-six owner-derived cases now check all five scope forms, exact identity projection, current User/Workspace/Thread/Turn forms, malformed segments, wrong identifier kinds, page/trace separation and reference authority fields. The unchanged guarded command passes all 256 tests: statements 98.15%, branches 94.77%, functions 100%, lines 98.13%, exit 0. No threshold, guard, schema or production parser changed. Logs: `/tmp/openkit-r2-ci-protocol-{red,green}.log`.

With only the existing generated executable set aside, the unchanged `pnpm -w test:smoke` built six TypeScript packages, passed health and Harness admission, then returned the identical Task 409 and exit 1. The original binary was restored. This is missing build supply, not a pre-Turn query-context refusal. The new actual-Turbo graph regression fails because the selected NanoCore build omits the kernel. The proposed correction adds the existing kernel build as a direct NanoCore build prerequisite, preserving failure semantics and avoiding any alternate retrieval path. Expected observable: the same smoke builds or restores the missing executable through Turbo and completes its public Task. Logs: `/tmp/openkit-r2-ci-smoke-red.log` and `/tmp/openkit-r2-ci-build-graph-red.log`.

## Build Supply Correction And Full Verification Prediction

The graph regression now passes all three packaging cases. A direct NanoCore build prerequisite selects the existing kernel task before its runtime consumer. The complete unchanged `pnpm -w test:smoke` then started with the executable absent, built seven packages including the kernel, passed health/deletion recovery, Harness admission, the public Task Worker MCP path and Web preview, and exited 0. No Task, retrieval, smoke driver or failure oracle changed. The original generated executable remains retained beside the replacement under ignored build output. Log: `/tmp/openkit-r2-ci-smoke-green.log`.

Next action: run the complete unchanged `pnpm -w verify:l0-l2` recipe. Expected observable: all repository checks, lint, typecheck, guarded package coverage, native/root tests and production builds pass, without a filter or threshold change. Shared `/tmp` has only about 50000 free inodes, so fixtures use a separate task-owned 8 GiB tmpfs with 2000000 inodes, as in the accepted R2 full-suite procedure. Local CPU affinity is limited to four CPUs to bound default test parallelism; the gate's commands, assertions and timeouts stay unchanged. Node 24.18.0 and Rust 1.97.1 match their accepted pins. Logs remain outside the mount. A real check failure pauses only its dependent correction; no guard is weakened. Unmount normally after every task-owned test process has exited.

## Verification Reframe

The first complete local L0-L2 attempt exited 1 in unchanged Worker Shim tests after nine package coverage suites passed. Worker Shim reported 24 failures out of 1018 cases. The log shows unexpected repository trust settings in retained native configuration and repository instructions in a native response. The task-owned temporary mount was inside this Git worktree, so native ancestor discovery defeated the fixture's intended isolation. This attempt is a failed gate and does not qualify L0-L2. No product, test, oracle or timeout is changed for this finding. Log: `/tmp/openkit-r2-ci-l0-l2.log`.

Reframe: put the same task-owned temporary filesystem outside the repository, at a fresh directory under `/tmp`, as CI does. First run representative unchanged Codex close/plugin and DeepSeek native-profile cases. Expected observable: they preserve exact fixture configuration and return the expected native response without repository context. An independent Consultant checks this route before repeating the full gate. The nine completed package suites remain historical observations, not a substitute full-gate result. The parallel NanoHost compile-only preparation exited 0 and supplies no test verdict.

The outside-repository probe passed all four selected previously failing cases; 166 other cases were name-filtered probe skips, not gate coverage. The independent Codex Consultant read the source intent, actual diff and both logs and returned Continue. Its next deciding observation is the complete unchanged L0-L2 command with the outside fixture root and the same four-CPU affinity. No human decision or production change is needed for this local setup correction. The first task mount was unmounted normally after the failed full process exited. The corrected complete L5 also passed with the executable absent on a warm Turbo cache: the kernel task was a cache hit and restored its root Cargo output before the public Task passed. Log: `/tmp/openkit-r2-ci-smoke-cache.log`.

## Additional R2 Root Fixture Finding

The second complete L0-L2 attempt passed all ten coverage owners, including all 1018 Worker Shim cases, and the native suites. It then failed three of 882 root tests: test-image placement and tag fixtures omit the three dictionary inputs added by R2. The actual digest producer correctly requires the dictionary script, vendored archive and COPYING notice. Its copied fixture trees still contain only the earlier inputs, so they fail with missing-file errors before their intended assertions. This is a third R2 integration cause, not a guard defect. Log: `/tmp/openkit-r2-ci-l0-l2-final.log`.

Next action: copy those exact binary-preserved inputs into the three existing fixture trees, retain every assertion, and prove each dictionary input changes the fixture image tag. Reproduce the whole file before correction, then rerun the whole root suite under its existing guard and complete the remaining CI build and App-update helper step. The product sources, build configuration and all package coverage subjects remain frozen; repeat only the root-owned checks affected by this fixture correction. Report both failed complete-command exits and the exact composed CI-equivalent results without calling either failed invocation a pass. Commit this separate cause separately.


## Final Verification Route

The whole image-environment fixture file reproduced the additional cause with 18 tests: 15 passed and 3 failed, exit 1. The correction copies the actual dictionary inputs without text conversion, preserves the existing assertions, and adds a tag-sensitivity assertion for each new input. The same whole-file command now passes all 18 tests with no skips, exit 0. Logs: `/tmp/openkit-r2-ci-env-fixtures-{red,green}.log`. The image cookbook now names the actual digest inputs.

An independent Codex Consultant rejected the proposed composed proof as insufficient for the user's explicit complete-gate request. Both literal full invocations failed, so their passing components cannot substitute for a final full-command exit 0. The next action is to commit the separate fixture correction, then run the unchanged `pnpm -w verify:l0-l2` on that final source HEAD with the outside-repository temporary filesystem and four-CPU setup, followed by the App-update helper. No test recipe, timeout, threshold or assertion is weakened.
