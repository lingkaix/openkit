---
type: change-plan
status: implemented
branch: fix/85-task-mode-review-linkage
---
# Task Mode Review Keyword And Host Linkage

## Intent Epoch 1

Source: GitHub issue #85. Task Mode rejected prompts containing `\breview\b` with `task_mode_not_delegated`, and host-authored dogfood pushes conflicted with `requireReviewLinkage=true`. Fix coordinator heuristics so concrete PR review/merge Tasks delegate, and exempt host App API pushes from review linkage without permanently disabling `requireReviewLinkage` on A2.

## Owners

`docs/specs` worker coordinator / Task Mode entry owns routing heuristics. `docs/specs/20260704-git_write_workflow.md` owns review linkage for publication. Host App API push remains distinct from worker-selected `openkit-repository` tools.

## Checkpoint

Implementation complete on `fix/85-task-mode-review-linkage`.

## Summary

Delegate concrete PR review/merge Task Mode prompts, and allow host-session linkage exemption while keeping worker review-linkage enforcement.

## Verification

- `vitest` worker-coordinator and git-push-linkage suites passed (51 tests across both files).
