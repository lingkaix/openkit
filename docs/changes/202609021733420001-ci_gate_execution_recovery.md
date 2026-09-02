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
- `turbo.json` adds `^build` to `typecheck` and `test`, so a task that consumes a workspace dependency's built types has that dependency built first. The pre-existing `^typecheck` and `^test` entries are retained: replacing them removed dependency tasks from filtered runs such as `turbo run test --filter=@openkit/nanocore`, which is a behavior change this repair does not need.
- Root `test:e2e:nano`, `test:e2e:web`, and `test:smoke` build through `turbo run build --filter=` rather than a single-package `pnpm --filter` build. `test:e2e:web` names `@openkit/web` as well as `@openkit/nanocore`, because `@openkit/core-client` is outside NanoCore's dependency set and was previously never built for that gate.
- `tests/test-execution-environment.test.mjs` gains two regressions: every image-placed job declares a `safe.directory` covering the container workspace, and the three gates build through the dependency graph while `typecheck` and `test` depend on `^build`.

The placement contract in the Test Execution Environment decision is preserved: each changed script stays wrapped by `scripts/test-env.sh any` exactly once and invokes no other placed root script.

## Evidence

- Both regressions were observed failing before the fix, naming all seven uncovered jobs and `{test: false, typecheck: false}`, then passing after it. The failing CI evidence is runs 33577531454 and 33555523546 (jobs 100084792967 and 100016429803) for the ownership defect, and jobs 100119263697 and 100133729147 for the build-order defect.
- `node --test tests/test-execution-environment.test.mjs tests/release-workflow.test.mjs tests/toolchain-version-mirrors.test.mjs`: 33 passed, 0 failed.
- `pnpm -w check:repo`: all validators passed, 952 files checked by Biome, no fixes applied.
- Direct proof of the build-graph defect and its correction: with every `packages/*/dist` and `apps/nanocore/dist` removed, `turbo run typecheck --filter=@openkit/nanocore --force` reproduced `TS2307` before the change and completed `7 successful, 7 total` after it. A dist-free `vitest run src/action-center.test.ts` reproduced `Failed to resolve entry for package "@openkit/app-api-schemas"`, and the corrected `test` task graph lists all seven dependency builds ahead of `@openkit/nanocore:test`.
- Direct proof of the ownership defect and both corrections: in a container whose repository is owned by another uid, `git ls-files` exits 128 with the same message, and exits 0 under either the `GIT_CONFIG_*` environment form or a global `safe.directory`.
- Both regressions were then shown to discriminate rather than merely pin a shape. Five mutations were applied one at a time and each was rejected: `safe.directory` set to `*`, to `/__w/`, and to `/__w/openkit/wrong`; `test:e2e:nano` filtered to a non-existent package; and `test:e2e:web` with its `@openkit/web` filter removed. The build-graph regression reads the selection back from Turbo's dry run and compares it against the dependency closure computed from the workspace manifests, rather than matching command text.

## Independent Review

An independent Codex reviewer, dispatched under the registered `reviewer` capability in `.codex/agents/reviewer.toml`, returned five findings and one adjacent observation. Four findings were adopted: the wildcard trust scope, the non-discriminating regressions, the lossy Turbo dependency replacement, and the missing run identifiers above. One was adopted in substance but not in remedy: NanoCore is built twice by `test:e2e:nano`, once by the Turbo selection and again by the package-local `test:e2e` script. The proposed remedy was a `@openkit/nanocore^...` filter, and that operator does not select a dependency closure. `@openkit/protocol^...` selects five packages although `@openkit/protocol` declares no workspace dependency, and `@openkit/nanocore^...` selects `@openkit/core-client`, which NanoCore does not depend on. The duplicate `tsc` is retained as the cheaper defect.

That probe also defeated a claim this record previously made. The first version of `test:e2e:web` used `@openkit/web^...` on the belief that the operator selects dependencies without the package. It produced the correct set for `@openkit/web` by coincidence, not by that rule, and was replaced with a plain `--filter=@openkit/web`.

## Residual Risk And Follow-up

Neither fix has been observed on a GitHub runner. The deciding evidence is a `workflow_dispatch` run with `gate=release-gate`, which exercises `l0-l2`, `nano-core-e2e`, and `smoke` together; until it runs, the local proofs stand for the mechanism and not for the hosted environment.

`NanoHost installer fixed-path gate` remains failing and is out of this change by engineer decision. Its self-check runs `bwrap --unshare-all`, and `ubuntu-latest` denies `CAP_NET_ADMIN` in an unprivileged user namespace under `kernel.apparmor_restrict_unprivileged_userns=1`, so loopback setup fails with `RTM_NEWADDR: Operation not permitted`. That job also runs its script directly rather than through the `host` placement its root script declares.

One adjacent finding is recorded here without an accepted owner and is not addressed by this change. The GitHub runner mounts `/var/run/docker.sock` into image-placed job containers, visible in the container-creation command of job 100084792967. The Test Execution Environment decision in `docs/toolchain.md` states that the image receives no Docker socket because handing it one would make its containment decorative. The runner supplies the mount rather than `ci.yml`, so the conflict is between that decision and the hosting environment, and it needs its owner's judgment rather than a local edit.

Trigger posture is unchanged. `push` remains tag-only, so a merge to `main` still runs no gate, and the first execution of these corrected gates will be a manual dispatch or a release tag.

## Owners

- `docs/toolchain.md` owns the Test Execution Environment decision, including placement and the CI realization list.
- `docs/specs/20260529-test_strategy.md` owns the gate layers and the trigger posture this change does not alter.
