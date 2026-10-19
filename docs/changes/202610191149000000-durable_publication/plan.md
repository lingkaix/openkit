---
type: change-plan
status: verified
date: 2026-10-19
completed: 2026-10-19
---
# Durable Publication Corrections

## Intent Revisions

1. The coordinator assigned the G5 publication gaps on 2026-10-19: complete bytes must be durable before their reference is published, success must follow the durable commit, and failed file publication must not advance derivative caches. Extend the existing helper only with link-or-fail creation; add no retained format or store.
2. The coordinator made package member changes conditional on a concrete broken reader or retry. An independent child-process test found an identical retry blocked by a partial `instructions.md` when both commit markers were absent. Keep direct member writes under the existing manifest boundary, discard only the unfinished package before that boundary, and atomically publish the final manifest.

## Authority

[Fault Tolerance](../../core/fault-tolerance.md) and [Storage](../../core/storage.md) own durable acknowledgement. [Worker Context Package](../../specs/20260703-worker_context_package.md) owns exact delivered history. [Agent Environment Package](../../specs/20260616-agent_environment_package.md) owns immutable snapshots. [Goal Mode](../../specs/20261002-goal.md) retains the Task terminal SQL fact and linked Goal revision commit before Turn-file projection; this change preserves that order.

## Scope And Necessity

Context traces and AEP capture/import reuse `writeFileAtomic` with no-clobber creation because rename could replace a racing immutable winner. Exact replay completes file and directory synchronization because a prior acknowledgement can have failed. The manifest alone gets atomic publication because a partial manifest cannot serve as the package commit marker. The existing Store writer accepts request-local candidates because moving cache assignment after a writer that reads the cache would otherwise persist old values. Thread counts join the local creation candidate. No candidate field is retained, and no cross-record transaction or automatic external-effect retry is added.

## Closeout

Completed and landed in `02cdd73bd05a910a7c8dbedade7613479071c8e9`. The common durable publication helper, Context trace and final manifest, immutable Agent Environment Package snapshots, and per-record candidate-cache acknowledgements are implemented. Post-publication directory synchronization failure refuses the affected Workspace until ordinary reopen. Task terminal SQL and Goal revision ordering remain unchanged. No retained format, automatic retry or new durable owner was added.

## Verification Evidence

The deciding full qualification is [CI 39280441370](https://github.com/lingkaix/openkit/actions/runs/39280441370), completed successfully on reviewed `b07ab47f1509008b19bf92a3ba02710ba410db5f`. The coordinator accepted the two stale aggregate job statuses at 16:41 UTC because every step, including job completion, succeeded. The subsequent clean main merge preserves the production and test bytes. The exact merged-head repository, lint and type checks passed at 16:36 UTC. Independent source review approved the landed head.

Local qualification failures remain part of the evidence: the complete four-directory run had 199 files and 3,546 cases, with 3,542 passes, four 30-second timeouts and a worker-exit timeout. Complete scheduler and pending-publication requalifications passed 153 and 13 cases with clean exit. Other Runtime requalification had 408 passes and six different timeouts; the Storage and library batch had 1,012 passes and three different timeouts. No whole local module gate pass or timeout cause is claimed. Filesystem fault injection and abrupt child death prove the named publication paths, not physical power-loss durability. The later containing-main run is separate post-landing evidence, not the deciding qualification above.

This correction touches six production files across four module owners: Storage, Store, Context and Agent Environment Package runtime. It adds no closed registry or owning document. Historical test-author commits and the reachable content-loss corrections are retained below. The planned correction is closed; future control-store redesign remains with its accepted owner.

## Historical Execution Evidence

The independent test author `/root/g5_publication_test_author` committed `976edb96313d58214a98cb52b7af114123616d9e` before production changes. On unchanged production, the final run had 16 intended failures and 9 passing controls in 14.99 seconds, with no collection or setup failure. It tests real filesystem operations, Store reopen, syscall faults and abrupt child death; it does not certify physical power-loss durability. The approved frozen F9 head was normally merged under the coordinator's explicit Store/helper region release. Its Workspace-owner fixture adaptation preserves all deciding assertions. Builder regressions now pass 25 of 25 in 14.33 seconds. Fresh independent review initially approved source `29114b2833af57745ca7b80ead32f5113ef2f807`. The complete module run then exposed a real post-rename failure: keeping an old cache after failed directory synchronization lets a later aggregate write overwrite the complete visible candidate. The independent author added mechanism-neutral regression `100010f55f62f62c9760534993974a278f62aa39`, which fails on that exact source in 6.96 seconds. It requires exact candidate preservation and accepts either a later success or a surfaced refusal; it does not decide recovery availability. Four other failures depend on the old pre-publication cache leak and require explicit divergent-cache fixtures while retaining their canonical export and dispatch oracles. Qualification of the known-defective head was stopped; its interrupted complete run proves no complete passing directory. The author branch and current main, including landed F9, are normally merged. The retry-boundary decision, correction, fresh review and complete affected suites plus Native typecheck remain open before landing. The coordinator authorized one process-local affected-Workspace refusal until ordinary reopen, with no retry or retained state. The independent author then replaced only its public old-cache observation in `3263b1d48c7102e4b12273c6432c49255b7063bd`: private cache equality remains, the public read must refuse with the named failure, and all exact byte and reopen assertions stay unchanged. That assertion fails on unchanged source in 6.14 seconds. The implementation identifies only post-publication directory sync failures, refuses affected cached reads and writes with the existing `recovery_required` code, and leaves unrelated scoped Workspaces usable. Unpublished staging failures retain their existing retry behavior. Fresh review and the complete four module directories plus Native typecheck remain required.

A fresh delta review reproduced a second content-loss route: the target record completes its durable commit, then later sibling preparation fails with a generic I/O error. The independent author committed `c49aa94d8ff5be477e5399245c775c886c53c0ce` before this correction; its single actual RED takes 8.79 seconds and proves exact-byte overwrite and stale reopen. The existing canonical writer now reports each record acknowledgement to its candidate cache, with no callback from an unpublished staged leaf. A later aggregate failure preserves that committed cache; an actual post-rename synchronization failure still invokes the approved Workspace refusal. No broader refusal, retained state or recovery mechanism is added.
