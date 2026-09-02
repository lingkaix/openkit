---
type: standalone-change
status: implemented
started: 2026-09-02
branch: main
---
# CI Gate Execution Recovery

## Observation

No CI run in this repository has ever reached a green gate. Two independent environment defects stopped every gate before it could observe its subject, so absent coverage was reading as an unrun pipeline rather than as a failure.

`PR lightweight repo check` failed on both open pull requests at the same line: `scripts/validate-agent-interface-reachability.mjs` calls `git ls-files`, and git refused the checkout with `fatal: detected dubious ownership in repository at '/__w/openkit/openkit'`. Image-placed jobs run as root while the bind-mounted checkout keeps the runner user's ownership. `actions/checkout` does declare the exception, but only under a temporary `HOME` its own steps use, which no later step reads.

`L3 NanoCore e2e` and `L5 smoke` failed with `TS2307: Cannot find module '@openkit/app-api-schemas'`. A workspace package publishes its types and entry through `dist`, which `.gitignore` excludes, and the gates built one package with `pnpm --filter` rather than the dependency graph. A developer machine passes because a previous build left `dist` behind; a clean checkout resolves nothing.

## Root Causes And Scope

The two defects are unrelated in mechanism and share only their effect. The first reaches every one of the seven image-placed jobs, not only `pr-check`. The second reaches `typecheck`, `test`, `test:e2e:nano`, `test:e2e:web`, and `test:smoke`, so `verify:l0-l2` would have failed at `typecheck` and again at `test:unit` the first time it ran.

## Change

- `.github/workflows/ci.yml` declares a workflow-level git `safe.directory` environment so every job's steps reach the checkout. One declaration covers all seven image-placed jobs.
- `turbo.json` points `typecheck` and `test` at `^build` instead of `^typecheck` and `^test`, so a task that consumes a workspace dependency's built types has that dependency built first.
- Root `test:e2e:nano`, `test:e2e:web`, and `test:smoke` build through `turbo run build --filter=` rather than a single-package `pnpm --filter` build. `test:e2e:web` uses `@openkit/web^...` to reach `@openkit/core-client`, which is outside NanoCore's dependency set and was previously never built for that gate.
- `tests/test-execution-environment.test.mjs` gains two regressions: every image-placed job declares a `safe.directory` covering the container workspace, and the three gates build through the dependency graph while `typecheck` and `test` depend on `^build`.

The placement contract in the Test Execution Environment decision is preserved: each changed script stays wrapped by `scripts/test-env.sh any` exactly once and invokes no other placed root script.

## Evidence

- Both regressions were observed failing before the fix, naming all seven uncovered jobs and `{test: false, typecheck: false}`, then passing after it.
- `node --test tests/test-execution-environment.test.mjs tests/release-workflow.test.mjs tests/toolchain-version-mirrors.test.mjs`: 33 passed, 0 failed.
- `pnpm -w check:repo`: all validators passed, 952 files checked by Biome, no fixes applied.
- Direct proof of the build-graph defect and its correction: with every `packages/*/dist` and `apps/nanocore/dist` removed, `turbo run typecheck --filter=@openkit/nanocore --force` reproduced `TS2307` before the change and completed `7 successful, 7 total` after it. A dist-free `vitest run src/action-center.test.ts` reproduced `Failed to resolve entry for package "@openkit/app-api-schemas"`, and the corrected `test` task graph lists all seven dependency builds ahead of `@openkit/nanocore:test`.
- Direct proof of the ownership defect and both corrections: in a container whose repository is owned by another uid, `git ls-files` exits 128 with the same message, and exits 0 under either the `GIT_CONFIG_*` environment form or a global `safe.directory`.

## Residual Risk And Follow-up

Neither fix has been observed on a GitHub runner. The deciding evidence is a `workflow_dispatch` run with `gate=release-gate`, which exercises `l0-l2`, `nano-core-e2e`, and `smoke` together; until it runs, the local proofs stand for the mechanism and not for the hosted environment.

`NanoHost installer fixed-path gate` remains failing and is out of this change by engineer decision. Its self-check runs `bwrap --unshare-all`, and `ubuntu-latest` denies `CAP_NET_ADMIN` in an unprivileged user namespace under `kernel.apparmor_restrict_unprivileged_userns=1`, so loopback setup fails with `RTM_NEWADDR: Operation not permitted`. That job also runs its script directly rather than through the `host` placement its root script declares.

Trigger posture is unchanged. `push` remains tag-only, so a merge to `main` still runs no gate, and the first execution of these corrected gates will be a manual dispatch or a release tag.

## Owners

- `docs/toolchain.md` owns the Test Execution Environment decision, including placement and the CI realization list.
- `docs/specs/20260529-test_strategy.md` owns the gate layers and the trigger posture this change does not alter.
