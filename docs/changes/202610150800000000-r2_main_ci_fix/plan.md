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
