---
type: change-plan
status: in-progress
date: 2026-10-19
---
# Durable Publication Corrections

## Intent Revisions

1. The coordinator assigned the G5 publication gaps on 2026-10-19: complete bytes must be durable before their reference is published, success must follow the durable commit, and failed file publication must not advance derivative caches. Extend the existing helper only with link-or-fail creation; add no retained format or store.
2. The coordinator made package member changes conditional on a concrete broken reader or retry. An independent child-process test found an identical retry blocked by a partial `instructions.md` when both commit markers were absent. Keep direct member writes under the existing manifest boundary, discard only the unfinished package before that boundary, and atomically publish the final manifest.

## Authority

[Fault Tolerance](../../core/fault-tolerance.md) and [Storage](../../core/storage.md) own durable acknowledgement. [Worker Context Package](../../specs/20260703-worker_context_package.md) owns exact delivered history. [Agent Environment Package](../../specs/20260616-agent_environment_package.md) owns immutable snapshots. [Goal Mode](../../specs/20261002-goal.md) retains the Task terminal SQL fact and linked Goal revision commit before Turn-file projection; this change preserves that order.

## Scope And Necessity

Context traces and AEP capture/import reuse `writeFileAtomic` with no-clobber creation because rename could replace a racing immutable winner. Exact replay completes file and directory synchronization because a prior acknowledgement can have failed. The manifest alone gets atomic publication because a partial manifest cannot serve as the package commit marker. The existing Store writer accepts request-local candidates because moving cache assignment after a writer that reads the cache would otherwise persist old values. Thread counts join the local creation candidate. No candidate field is retained, and no cross-record transaction or automatic external-effect retry is added.

## Working Checkpoint

The independent test author `/root/g5_publication_test_author` committed `976edb96313d58214a98cb52b7af114123616d9e` before production changes. On unchanged production, the final run had 16 intended failures and 9 passing controls in 14.99 seconds, with no collection or setup failure. It tests real filesystem operations, Store reopen, syscall faults and abrupt child death; it does not certify physical power-loss durability. The approved frozen F9 head was normally merged under the coordinator's explicit Store/helper region release. Its Workspace-owner fixture adaptation preserves all deciding assertions. Builder regressions now pass 25 of 25 in 14.33 seconds. Fresh independent review initially approved source `29114b2833af57745ca7b80ead32f5113ef2f807`. The complete module run then exposed a real post-rename failure: keeping an old cache after failed directory synchronization lets a later aggregate write overwrite the complete visible candidate. The independent author added mechanism-neutral regression `100010f55f62f62c9760534993974a278f62aa39`, which fails on that exact source in 6.96 seconds. It requires exact candidate preservation and accepts either a later success or a surfaced refusal; it does not decide recovery availability. Four other failures depend on the old pre-publication cache leak and require explicit divergent-cache fixtures while retaining their canonical export and dispatch oracles. Qualification of the known-defective head was stopped; its interrupted complete run proves no complete passing directory. The author branch and current main, including landed F9, are normally merged. The retry-boundary decision, correction, fresh review and complete affected suites plus Native typecheck remain open before landing. No new refusal mechanism has been implemented.
