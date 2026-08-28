---
type: change-plan
status: verified
---
# V1 Release Readiness Cleanup

## Intent

Before the first stable release, make `worker-common` directly usable by end users as a public GHCR base, record that the professional-workspace Web SPA has no current bundle-byte release budget, and remove temporary inputs and local Docker artifacts retained by completed work.

## Owners

- `docs/specs/20260708-container_image_packaging.md` owns release-image publication and public access.
- `docs/specs/20260710-web_ui_rebuild_stack.md` owns the Web implementation and delivery posture.
- `docs/change-execution.md` owns change-record and temporary-evidence retention.

## Acceptance

- The packaging owner and release preflight require exactly one public empty-runtime worker base, the tag workflow verifies an anonymous pull of its exact published digest, and the release cookbook explains the one-time first-publication visibility step.
- The Web stack owner states that Vite chunk-size warnings are informational rather than release gates until an accepted measured performance objective establishes a budget, and EETB-FND-006 is closed without code splitting or Vite tuning.
- The engineer-selected Agent Function Model and execution-boundary temporary inputs, obsolete governance drafts, and the completed findings-contract migration helper are absent, with any residual from deleting an unverified absorption source recorded rather than hidden.
- The exact retained local OpenKit worker and test images and `openkit-test-env-cc4e1f23ae21-*` volumes are absent after confirming no container uses them.
- Active NanoHost evidence under `temp/state/`, A1 and NHC probes, `temp/nhc5c-probe/`, and `refs/stash` remain intact.

## Effect Boundary

Repository documentation, release workflow, one static workflow regression, ignored completed-plan temporary files, and exact local Docker artifacts are in scope.
Publishing, tagging, pushing, changing a live GHCR package, deleting active NanoHost evidence, and deleting the protective Git stash are out of scope.

## Intent Epochs

### Intent Epoch 1 — 2026-08-29 / engineer merge instruction

After an independent Herdr-managed Claude Code review passes, commit every worktree change, merge the complete branch into local `main`, and delete the merged source branch.
The instruction authorizes the local commit, fast-forward merge when ancestry permits it, and local branch deletion; it does not authorize a push, release tag, package publish, deployment, live GHCR visibility mutation, active NanoHost evidence deletion, or stash deletion.

## Current Checkpoint

- Direct GitHub API inspection on 2026-08-28 returned `Package not found` for `lingkaix/openkit-worker-common`, and an unauthenticated GHCR token request returned HTTP 403, so no live package visibility can yet be claimed.
- GitHub's supported first-publication flow creates a private package before an administrator changes its visibility; the release gate must therefore fail until the first package is made public and then pass on a rerun.
- The repository-required fresh-context direction check returned `Continue`: use native public visibility plus a logged-out exact-digest inspection, close the Web warning by accepted product posture, delete completed-plan inputs and reproducible Docker state, and preserve the active NanoHost evidence and stash.
- The packaging and Web owners, release workflow, cookbook, findings, and regression now implement the accepted outcomes, the exact cleanup is complete, and the ordinary independent reviewer returned `PASS` after two release-gate findings were corrected.
- The independent Herdr-managed Claude Code Opus 5 audit returned `REJECT` with four findings, the four findings were corrected without changing release workflow logic, and the same Claude session returned final `PASS` after inspecting the corrected bytes and rerunning the named checks.
- Terminal release verification exposed four small test-instrument defects outside the release-policy slice: server-mode NanoCore e2e used its production non-loopback bind default despite a loopback harness URL, two real-process tests used load-sensitive startup deadlines, and Web preview cleanup treated a macOS `EPERM` process-group probe as an unknown failure. The harness now fixes the e2e listener to loopback, retains the same assertions under bounded 10-second and 500-millisecond startup allowances, and treats `EPERM` only as a still-live group within the existing cleanup deadline; the final full release gate exits zero.
- A fresh final Herdr-managed Claude Code Opus 5 audit inspected the complete worktree including all four terminal-gate corrections, independently checked the Git ancestry and retained cleanup state, and returned `PASS` with no blocking finding.
- Next Action: commit every worktree change, fast-forward local `main`, delete the merged source branch, and leave the first live package-visibility operation to the release procedure.

## Closeout Summary

- **Verdict:** Verified for first-release preparation and independently accepted; only the authorized terminal Git handoff remains.
- **Public base:** Release preflight requires exactly one structural public worker base, the current base is `worker-common`, and the tag workflow removes GHCR login before inspecting the exact pushed digest.
- **Web posture:** Bundle byte size and Vite chunk warnings are informational until an accepted measured performance objective creates a release budget, so EETB-FND-006 is closed without production or Vite changes.
- **Temporary files removed:** The three obsolete July and early-August proposals, the six Agent Function Model and cleanup inputs dated 2026-08-09 or 2026-08-13, `temp/20260815-goal-mode-engine-design/`, `temp/20260820-agent-loop-landing/`, and `temp/changes/202608271240120001-findings_record_contract/` are absent.
- **Residual finding:** Agent Function Model F-16 records that the WP-5/WP-6 absorption source was deleted under the later engineer cleanup direction while F-9 remains unmet; accepted owner bytes and Git remain authoritative, but the deleted argument is unavailable if a future Tier-4 gate disputes an absorbed decision.
- **Docker cleanup:** Eight exact OpenKit image tags and all sixteen `openkit-test-env-cc4e1f23ae21-*` volumes were deleted after confirming that no matching container existed, and a post-delete inventory returned no matching image or volume.
- **Preserved active state:** `temp/state/`, `temp/nhc5c-probe/`, active A1 and NHC material, and the one protective stash remain because the NanoHost plan is still `in-progress` and its baseline commits are not ancestors of current `HEAD`.
- **External effects:** Read-only GitHub and GHCR probes observed no package; no tag, publish, push, deploy, package-visibility mutation, or other remote write occurred.
- **Commit:** The engineer authorized one terminal commit of all worktree changes followed by a local fast-forward merge into `main` and deletion of the merged source branch; Git history containing this record is the commit evidence.

## Verification Evidence

- `mise exec -- node --test tests/release-preflight.test.mjs` passes 13 of 13 tests.
- `mise exec -- pnpm -w check:repo` validates the current specification lifecycle, document model, generated index, Agent interface reachability, terminology, test governance, Biome corpus, and models catalog.
- `mise exec -- pnpm --filter @openkit/nanocore run test:e2e` passes 15 of 15 files and 20 of 20 tests, `mise exec -- node --test tests/app-image-entrypoint.test.mjs` passes 5 of 5 tests, `mise exec -- node --test tests/nanohost-unit-f-runner.test.mjs` passes 71 of 71 tests, and `mise exec -- pnpm -w test:smoke` passes both built-artifact smokes.
- `mise exec -- pnpm -w verify:release` exits zero after repository validation, lint, typecheck, unit tests, coverage, build, NanoCore e2e, and NanoCore and Web smoke checks.
- Direct YAML parsing succeeds, `git diff --check` exits zero, the ordinary reviewer returns `PASS`, the first independent Herdr-managed Claude Code Opus 5 audit returns final `PASS` after its initial four findings are corrected, and a fresh final Claude Code audit of the complete post-gate worktree also returns `PASS`.
- Post-cleanup inventory finds none of the named completed-plan inputs, OpenKit image tags, or `openkit-test-env-cc4e1f23ae21-*` volumes, while the active NanoHost evidence and one protective stash remain present.
