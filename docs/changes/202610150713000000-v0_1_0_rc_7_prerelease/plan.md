---
type: change-plan
status: in-progress
date: "2026-10-15"
started: "2026-10-15"
branch: release/v0.1.0-rc.7-prep
---
# v0.1.0-rc.7 Prerelease Preparation

This record preserves rc.7 preparation, publication proof and pending gates. It supplies no design or publication authority.

[Release Management](../../specs/20260829-release_management.md), the [Release Cookbook](../../cookbooks/release.md), [Test Strategy](../../specs/20260529-test_strategy.md) and the [standing scratch grant](../../decisions/20261015-standing_scratch_rehearsal_grant.md) govern this work. The preceding release record is [rc.6](../202610131730000000-v0_1_0_rc_6_prerelease/plan.md).

## Intent

### Intent Revision 1 — 2026-10-15

Source: the coordinator asked for rc.7 preparation on a fresh branch and worktree from current origin/main. Include staged native startup, Retrieval Kernel R2 and the shared-conversation design record. Prepare the #248 entry from its reviewed branch, initially pending integration. Carry the named known issues and notice gaps. Run repository checks and commit locally. The coordinator owns final admission and the tag push. Stable publication and strict-risk dispositions stay engineer-reserved; #223 stays unlabeled. No deployment-host contact or real publication is authorized. Scratch rehearsal is conditional on the accepted publication-path procedure.

### Intent Revision 2 — 2026-10-15

Source: the coordinator confirmed #248 on main as `3a80b6d7` and `06b0d27c`. Rebase onto `06b0d27c`. Describe the correction as fixed pending host verification. Keep #248 open until the published rc.7 NanoHost reaches a positive ready generation on a real host. Remove the pending-integration mark; retain the host-verification gate.

### Intent Revision 3 — 2026-10-15

Source: the coordinator relayed two engineer rulings for rc.7 admission. Record the original questions, selected answers and option text verbatim, with faithful English translations. Apply the #223 disposition to every prerelease before the first `v0.1.0` stable release. Permit prereleases with the four disclosed notice gaps; track their first-stable closure in #249. Keep both issues unlabeled. Commit this increment separately for the ongoing independent Grok review; do not amend or publish.

### Intent Revision 4 — 2026-10-15

Source: the coordinator relayed the Grok review's required correction to the malformed fresh-branch source identity. Resolve the full identity directly from Git and mechanically check all hexadecimal references in this record and the rc.7 notes. Commit the correction separately. Base main-push CI failed; its correction is being built on `v010/r2-main-ci-fix`. Do not rebase until the coordinator confirms that correction on main. Then include the landed correction in the notes and refresh issue reconciliation, including #249. No push, tag or publication is authorized.

## Engineer Rulings — 2026-10-15

The coordinator supplied these engineer selections on 2026-10-15. Chinese quotations are retained verbatim as requested; the English translations preserve their scope.

### #223: All Prereleases Before The First Stable Release

Question (Chinese, verbatim):

> #223（部分写入在 rename 前没有 fsync，断电可能丢一条记录）在 rc.6 时你裁定为：公开披露、不阻塞 rc.6，但阻塞第一个正式版。这个裁定只写了 rc.6，rc.7 需要你重新确认。怎么处理？

Selected answer (Chinese, verbatim):

> 正式版前都沿用

Option text (Chinese, verbatim):

> 所有 v0.1.0 正式版之前的预发布都按 rc.6 的裁定处理：公开披露、不阻塞，仍然阻塞第一个正式版。以后的 rc 不用再问你。

Faithful English translation of the question: "For #223 (some writes do not fsync before rename, so power loss can lose a record), your rc.6 ruling was: disclose it publicly, do not block rc.6, but block the first stable release. That ruling named only rc.6, so rc.7 needs your confirmation. How should we handle it?"

Faithful English translation of the selected answer: "Keep applying it before the stable release."

Faithful English translation of the option: "Apply the rc.6 ruling to all prereleases before the v0.1.0 stable release: disclose it publicly and do not block, while retaining it as a blocker for the first stable release. Later release candidates do not need to ask you again."

Disposition: #223 is a disclosed non-blocker for rc.7 and every later prerelease before the first `v0.1.0` stable release. It remains a first-stable blocker and stays unlabeled. Later rc admission needs no new #223 ruling. The defect remains open; this ruling does not itself perform or widen a deployment reset.

### Four Notice Gaps: Disclose For Prereleases, Close Before Stable

Question (Chinese, verbatim):

> rc.7 是第一个带 retrieval-kernel 二进制的版本，其中 4 个 Rust crate 的许可证说明没找齐：htmlescape 0.3.1、kanaria 0.2.0，以及两个 winapi-*-pc-windows-gnu 0.4.0（这两个是 Windows 专用 crate，很可能不会编进 Linux 镜像）。缺口已写在镜像里的 GAPS.json 和发布说明中。怎么处理？

Selected answer (Chinese, verbatim):

> 披露后发布

Option text (Chinese, verbatim):

> 预发布照常发，缺口公开披露；第一个正式版之前必须补齐。我会另开 issue 跟踪补齐工作。

Faithful English translation of the question: "rc.7 is the first version carrying the retrieval-kernel binary. License notices are incomplete for four Rust crates: htmlescape 0.3.1, kanaria 0.2.0 and the two winapi-*-pc-windows-gnu 0.4.0 crates. The last two are Windows-only crates and are likely not compiled into the Linux image. The gaps are recorded in GAPS.json inside the image and in the release notes. How should we handle them?"

Faithful English translation of the selected answer: "Publish after disclosure."

Faithful English translation of the option: "Publish prereleases as usual, with the gaps publicly disclosed. Complete the missing notices before the first stable release. I will open a separate issue to track that work."

Disposition: prereleases may ship with these four gaps disclosed. All four must be closed before the first stable release. The coordinator supplied [#249](https://github.com/lingkaix/openkit/issues/249) as the new tracking issue. It is a first-stable blocker, remains unlabeled and does not block rc.7 under this ruling. No complete notice provenance or compliance result is claimed. The question's Windows-build statement remains qualified as likely, not a verified packaging result.

## Preparation Checkpoint — Rewritable

| Field | Current fact or pending gate |
| --- | --- |
| Tag and channel | `v0.1.0-rc.7`, non-draft prerelease; no GHCR `latest` or GitHub Latest assignment |
| Previous release | `v0.1.0-rc.6`, exact source `0aa3f9a24e4cd0fdbec36b8d5f72d374a0086b3c` |
| Fresh branch | `release/v0.1.0-rc.7-prep`; created from `c2fc03985de30a0de60e31edb1afa75fb6b2d730`, then rebased onto confirmed main `06b0d27c57b341b335942fc485bed9acc4783c0b` |
| Base CI | Main-push run [38697916406](https://github.com/lingkaix/openkit/actions/runs/38697916406) completed `failure` in L0–L2 and L5 smoke. The coordinator identifies the protocol coverage guard and R2 Worker MCP smoke HTTP 409. Correction is pending on `v010/r2-main-ci-fix`; no final-P gate has passed |
| Tested commit T | No successful final-P candidate run is claimed. Update T from completed actual candidate evidence before final admission |
| Publishing commit P | Final preparation HEAD, exact SHA supplied in the handoff. It requires independent review, main membership and successful candidate CI on exactly P |
| Preparation diff | Release notes, this record and minimum four-attachment status projections. No product implementation, publication job or invoked script changes |
| Controlled assets | Three catalog release images; operations archive with reviewed helper; target-native NanoHost archives for amd64 and arm64; `SHA256SUMS`. Exactly four portable attachments; manifest delivery remains conditional on the rehearsed #225 path |
| Checklist identity | Release Management `7b266ae721211cf2c13b0af0b6897e911218b3cf`; Release Cookbook `39f1feeb4e1b99e3c24d1a68750d1e07035d33ec`; Test Strategy `3874ba2855230dd4a5b783c6452c287a07a70d31`. These Git blob identities freeze the governing checklist for this preparation |
| Visibility posture | Public GitHub repository; only `worker-common` is required to support anonymous GHCR inspection. No visibility change is authorized |
| Grant | Standing prerelease grant first covers rc.6 and includes rc.7 while all owner predicates hold. This preparer commits locally; the coordinator admits and tags |
| Publication proof | The three publication job blocks and nine invoked script inputs match rc.6. Successful rc.6 tag run is the baseline below. No new scratch rehearsal is required for that unchanged proved mechanism |
| Known host limits | #248 is fixed in source, pending published-asset positive readiness. #242 remains unverified on that host path. Neither issue is closed here |
| Risk dispositions | The 2026-10-15 engineer rulings admit #223 as a disclosed non-blocker for every prerelease before first stable `v0.1.0`, without another rc question. The four disclosed notice gaps are permitted in prereleases and tracked by #249. Both issues block first stable and stay unlabeled |
| Manual gates | Catalog stories remain post-tag at release-cycle/change cadence. Worker qualification runs after the deployment update, separately from L6. No live result is claimed |
| Production boundary | No contact with staging or production. No push, tag, release, label, visibility or credential change by this preparer |
| Next action | Await the coordinator's confirmation that the CI correction has landed on main. Until then, keep this branch unchanged by rebase. After confirmation, rebase, describe the landed correction, refresh reconciliation including #249, and repeat focused checks and publication comparison |

## Included Work Since rc.6

- `7eb826d9` and `3599b3fa` implement staged native startup and CPU-limited admission. The source issue #245 is closed. The default remains at most two cold starts, limited by affinity and cgroup quota, with conservative fallback. It does not lower the separate active-Turn count or weaken ordinary RPC ceilings. #246 remains a separate one-CPU OpenCode retaining-close failure.
- Retrieval Kernel R2 comprises fifteen commits from `5df73d02` through `cb3c6b7d`. They replace lexical JSON retrieval, supervise the kernel service and package its target-native executable and verified dictionary. They add trusted query context, qualified pins/citations, write-once query-owned traces, the S39 pre-Turn reference and S51 owner/remint rules. [The R2 record](../202610150000000000-retrieval_kernel_r2/plan.md) retains detailed evidence and excluded work. Historical notebook reconstruction, arbitrary-file upload and Assistant history Tool admission are not supplied by this release.
- `bbc901dc`, `d2bbdce7` and `0d6eee79` record and refine the [shared-conversation decision](../../decisions/20261015-shared_conversation_and_single_agent_threads.md). The coordinator named `0d6eee79` as its final source. `c2fc0398` updates the [core-experience plan](../202610140256550000-v0_1_0_core_experience/plan.md). These are design and planning changes; #247 remains after `v0.1.0` and adds no shared-conversation feature here.
- `3a80b6d7` and `06b0d27c` implement #248: `h2` ALPN in both verified trust branches, one absolute 120-second startup bound through TCP/TLS/HTTP2/admission, and startup invalidation with `epoch-creation-failure` on initial TCP expiry. They preserve certificate verification and provide no plaintext fallback. Published-artifact host readiness is still unverified.

## Publication-Path Proof

The existing `publicationInputsAt` reader checks immutable Git bytes, not two caller-supplied hashes. Its comparison covers all three publication job blocks and nine invoked files with the static dependency closure required by the release owner.

[rc.6 tag run 38682273335](https://github.com/lingkaix/openkit/actions/runs/38682273335), attempt 1, completed success at source `0aa3f9a24e4cd0fdbec36b8d5f72d374a0086b3c`. Its release is non-draft and a prerelease, published at `2026-10-15T05:16:37Z`. The following five jobs actually executed successfully:

| Publication job | Job ID | Result | Completed at (UTC) |
| --- | --- | --- | --- |
| Publish app image | `116251492649` | `success` | `2026-10-15T05:16:24Z` |
| Publish worker-common image | `116251492607` | `success` | `2026-10-15T05:00:57Z` |
| Publish worker-runtimes image | `116251492593` | `success` | `2026-10-15T05:15:47Z` |
| Publish GitHub Release | `116260518201` | `success` | `2026-10-15T05:16:39Z` |
| Verify published release | `116260586551` | `success` | `2026-10-15T05:18:03Z` |

The rc.6 and current rc.7 source aggregate is `9029285e5b35bf435c3f5afb0fe90600151b8f00c5f27caa433b49bba5cbd1e4`. Their per-input Git blob identities are equal:

| Input | Git blob at both sources |
| --- | --- |
| `publish-container-images job` | `5b904b9a1cfcc58f40419332dfd7d2de1f599581` |
| `github-release job` | `734976e10dcbce2a92b09b7cd3bf84b8bc4a3821` |
| `verify-release job` | `c6030d2217362808cae8c3dce2f62805cb6c7940` |
| `scripts/release-image-state.mjs` | `129c09a2e2489b617760c08db2fdc1bb37ca1db2` |
| `scripts/release-notes.mjs` | `c4bb3ebce44c9f240c75bbd21b757580fa26d14d` |
| `scripts/package-release-assets.mjs` | `6a0a31c621a20cc413eebb58ea57eeacc0e40fd1` |
| `scripts/verify-nanohost-release.mjs` | `687c837d8d12385d9faa61aef79e2aead14e9d40` |
| `scripts/lib/nanohost-elf.mjs` | `3db207f37fb7e96dc1b0a8cb50b516b0842afe1c` |
| `scripts/release-preflight.mjs` | `87d2cd0a6b44472f916d83569a7096aa54d08702` |
| `scripts/validate-doc-model.mjs` | `fd4b0fcb1d825b78d1892371f09afbe2328900f5` |
| `scripts/docker/app-update-helper.py` | `56d8023549062c278b50404a4053a667404176ee` |
| `scripts/lib/doc-fields.mjs` | `fc88cd5d4b3a12c29a1df0245579ed338136fc8f` |

R2 changes the App Dockerfile, its smoke test and retrieval build supply. These change the product image payload; the publication control jobs and admitted script closure remain unchanged. Exact-P candidate CI and tag-time exact-image smoke still qualify those new bytes. #248 changes the NanoHost payload and test ordering without changing this publication mechanism. The preparer therefore makes no scratch write. If a later change alters the publication mechanism, repeat comparison and use the bounded scratch grant before a real tag.

## Known Issues, Dispositions And Disclosure

The refreshed read-only backlog contains 111 open issues and no issue carrying `release-blocker`. Its issue-number set equals the rc.6 record's 108 rows, minus closed #245, plus #246, #247, #248 and new #249. The earlier rc.7 snapshot had 110 rows; #249 is the only addition and no issue was removed. Carry unchanged owner/disposition/disclosure rows from the [rc.6 reconciliation](../202610131730000000-v0_1_0_rc_6_prerelease/plan.md#initial-release-blocker-reconciliation), with these current deltas. Label absence does not establish admission.

| Finding | Owner or receiver | Current disposition and disclosure |
| --- | --- | --- |
| #245 | [Runtime Scheduling](../../specs/20260703-runtime_scheduling_scale.md) | Closed after staged startup and CPU-limited admission; listed under changes, removed from current known failures. No new provider/host qualification claim |
| #246 | [OpenCode Adapter](../../specs/20260716-opencode_worker_adapter.md) | Disclosed one-CPU close-proof failure. Keep errors, fencing and all assertions/deadlines; do not claim native persistence or successful retaining close. Separate from #245 |
| #247 | [Shared Conversation Decision](../../decisions/20261015-shared_conversation_and_single_agent_threads.md) | Deferred until after `v0.1.0` and the private Timeline. Design record only; not a delivered feature |
| #249 | Retrieval Kernel notice supply, `apps/retrieval-kernel/notices/GAPS.json`, engineer ruling above | The four gaps may ship in prereleases with public disclosure. Close all four before first stable. Open first-stable blocker, unlabeled; notes and this record disclose the exact crate/version set |
| #248 | [NanoHost Runtime](../../specs/20260802-nanohost_runtime_and_transport.md) | Fixed in source, pending published rc.7 positive ready generation on a real host. Open issue retained; notes and this record disclose the limit |
| #242 | NanoHost image preparation under the same runtime owner | Source correction remains included. rc.6 stopped before positive readiness and did not exercise registry preparation. Verify after rc.7 readiness; no pass or issue closure inferred |
| #223 | [Work Data Retention](../../specs/20260921-work_data_retention_format.md), engineer ruling above | Disclosed non-blocker for all prereleases before first stable `v0.1.0`; later rc admissions need no new ruling. Still a first-stable blocker, open and unlabeled. The notes carry the defect and disposition |
| #120 | NanoHost R001 runtime gate and Release Management | Stable/readiness hold stays open. Hosted distribution qualification and source transport regressions do not replace the exact-product runtime proof |
| #195 | Release installation guide | Existing incomplete release-only first-install procedure remains disclosed. No host operation or guide-completion claim |
| #222 | [Knowledge Store](../../specs/20260703-knowledge_store_implementation.md), Retrieval Kernel | R2 changes the search path and has embedded-CJK regressions. Keep broader open issue status; do not turn these tests into a published-host or complete-answer acceptance claim |
| #158 | [Workspace Backup](../../specs/20260704-workspace_backup_export_import.md) | V2 export/import exists. Whole-deployment recovery and complete historical closure remain incomplete; missing required closure fails closed. Notes no longer claim all re-import is absent |

The remaining stable prerequisites #225 and #240 stay outside routine prerelease closeout. #241 manifest attachment delivery remains planned with #225 and needs its own publication-path rehearsal. No stable publication is authorized.

### Retrieval Notice Gaps

The App image retains supplied notices, SPDX metadata and `apps/retrieval-kernel/notices/GAPS.json`. The four unresolved records are:

| Crate | Version | Recorded gap |
| --- | --- | --- |
| `htmlescape` | `0.3.1` | No recorded upstream revision; no release tag verified |
| `kanaria` | `0.2.0` | No matching upstream license file obtainable at recorded revision `c994ccf06d179851a1c7c3285c3a408ccb6279ec` |
| `winapi-i686-pc-windows-gnu` | `0.4.0` | No recorded upstream revision; no release tag verified |
| `winapi-x86_64-pc-windows-gnu` | `0.4.0` | No recorded upstream revision; no release tag verified |

These are disclosed supply/provenance gaps. The 2026-10-15 engineer ruling permits prerelease publication with disclosure and requires closure of all four before first stable. #249 tracks that work and remains unlabeled. Do not invent a revision or claim complete notice compliance. The dated ruling above supplies the disposition; it is not a compliance verification.

## Verification Evidence

Node is `v24.18.0`. `pnpm install --frozen-lockfile` completed successfully with pnpm `10.33.3` after relocating the worktree off inode-exhausted `/tmp`.

`node scripts/validate-doc-model.mjs` printed `Validated documentation model (485 documents).`; `node scripts/validate-spec-lifecycle.mjs` printed `Validated spec lifecycle metadata.`; `node scripts/generate-doc-index.mjs --check` printed `Documentation index is current.`; `node scripts/validate-story-schema.mjs` printed `Validated story schema (10 stories).` All exited 0. The index was regenerated only with its generator and has no tracked content change.

`node scripts/release-notes.mjs --check --repo-root . --tag v0.1.0-rc.7` printed `Release notes input passed for v0.1.0-rc.7.` `node scripts/release-preflight.mjs --tag v0.1.0-rc.7 --repo-root .` printed `Release preflight passed for 0.1.0-rc.7.` and `Release images: app, worker-common, worker-runtimes`. Both exited 0. This preflight does not establish main membership or final candidate CI.

The seven focused root suites are `tests/release-manifest.test.mjs`, `tests/release-notes.test.mjs`, `tests/release-publication-check.test.mjs`, `tests/release-workflow.test.mjs`, `tests/release-preflight.test.mjs`, `tests/package-release-assets.test.mjs` and `tests/retrieval-packaging.test.mjs`. The first run reported 193 tests, 190 passed, three failed and zero skipped. The failures correctly rejected an extraction directory inside the checkout. The final unchanged run uses task-owned disk-backed temporary storage outside the checkout. It reported `tests 193`, `pass 193`, `fail 0`, `skipped 0`, exit 0. No failing run is a pass.

Focused Biome printed `Checked 0 files`; it supplies no Markdown lint evidence. Documentation validators are the deciding checks for this documentation slice. `git diff --check` exited 0 with no output. No test or oracle was changed.

Local checks do not establish candidate CI, main membership or final publication admission.

### Engineer-Ruling Increment Verification — 2026-10-15

All six Chinese question, selected-answer and option quotations were compared with the supplied strings and match exactly. Their English translations were checked for scope and the distinction between a disclosed prerelease non-blocker and a first-stable blocker. The live issue refresh shows 111 open issues, with #249 as the only addition; #223 and #249 are open and unlabeled.

The seven focused root suites were rerun unchanged after this increment: `tests 193`, `pass 193`, `fail 0`, `skipped 0`, exit 0. Documentation model validation again reported 485 documents; lifecycle, generated-index and ten-story checks passed. The rc.7 notes check and local release preflight passed with the exact result lines above. Focused Biome checked zero Markdown files, and `git diff --check` exited 0. Incremental independent review and exact-P candidate CI remain separate pending gates.

### Review Correction And Mechanical Identity Guard — 2026-10-15

The review found a malformed 41-character branch-source reference. The correction uses the exact output of `git rev-parse --verify c2fc0398^{commit}`. No full repository commit identity was typed for this correction. The task-local guard scans both this record and the rc.7 notes, extracts maximal hexadecimal tokens of at least 40 characters, and rejects unsupported lengths. This also catches a malformed token that a word-bounded 40-character regex alone would miss.

Run the retained task probe from the preparation checkout:

```bash
node temp/changes/202610150713000000-v0_1_0_rc_7_prerelease/verify-record-identities.mjs /tmp/rc7-record-identities-audit.json
```

The before-fix probe exited 1 on the malformed token. After correction, the guard found 20 unique 40-hex values across 21 occurrences. Four resolve through `git cat-file -e <id>^{commit}`. Twelve resolve through `git cat-file -e <id>^{object}` and have type `blob`. The four values below do not resolve in this repository and are listed explicitly. The guard checks their recorded provenance instead of creating objects to make existence checks pass.

| Recorded identity, short prefix | Why no local Git object exists | Mechanical source check |
| --- | --- | --- |
| `5b904b9a`: `publish-container-images` publication block | Git blob identity computed for a YAML block, not stored as a separate object | Recomputed by `publicationInputsAt` from actual Git source bytes |
| `734976e1`: `github-release` publication block | Git blob identity computed for a YAML block, not stored as a separate object | Recomputed by `publicationInputsAt` from actual Git source bytes |
| `c6030d22`: `verify-release` publication block | Git blob identity computed for a YAML block, not stored as a separate object | Recomputed by `publicationInputsAt` from actual Git source bytes |
| `c994ccf0`: `kanaria 0.2.0` upstream revision | Recorded upstream revision, outside this repository | Matched to the revision in Git-owned `apps/retrieval-kernel/notices/GAPS.json` |

Three unique 64-hex SHA-256 digests are also listed separately. They are content digests, not Git object names:

| Digest, short prefix | Meaning | Mechanical source check |
| --- | --- | --- |
| `9029285e` | Publication-input aggregate from publicationInputsAt | Recomputed from the named source or retained archive bytes |
| `93889bfd` | Retained local operations archive SHA-256 | Recomputed from the named source or retained archive bytes |
| `254a0126` | Reviewed helper file SHA-256 | Recomputed from the named source or retained archive bytes |

The final guard exits 0 with no malformed or unexplained references. Its full report retains every value and source location. This existence/provenance check does not replace review of what a reference means. All broader preparation checks remain recorded above; final-P main membership, successful exact-P candidate CI and admission remain pending.

### Committed Operations Archive Probe

Preparation candidate `d62f527228f2b2a2839f820dd026764be3ee6dc8` produced `openkit-ops-skill-v0.1.0-rc.7.tar.gz`. `sha256sum -c SHA256SUMS` printed `openkit-ops-skill-v0.1.0-rc.7.tar.gz: OK`. The archive SHA-256 is `93889bfd1e46592391fb321dd97bc90551a41c71c62a8d78155528ec07fda098`. The existing shared operations verifier passed after extraction outside the checkout, including packaged CLI discovery. Archived helper bytes equal the selected Git source; helper SHA-256 is `254a012630fb6283927c7c92d2f1c723624d4d4fba4068d139eb01da1eea4a74`.

The subsequent record-only commit retains this result and changes no archive payload input. The handoff verifies both publication-input equality and the operations tree, repository license and helper Git identities at final preparation HEAD. This local probe does not qualify future published archives; tag-time packaging and download verification remain required on exact P.

## Final-P And Admission Handoff

After independent review, land the chosen exact P in main and wait for its successful main-push release gate. A green run on `06b0d27c` cannot be reused across commits for a later preparation P. L0–L2 and L3 tag reuse stays per job and exact commit only.

The coordinator then refreshes the applicable unrevoked grant, reviewed exact P/main membership, successful required candidate jobs, unchanged publication proof, unused rc.7 tag/release/source-revision image identities, Latest state, complete current issue triage, applicable strict-risk dispositions and fixed prerelease flags. Keep that evidence private and bounded by its declared validity. Run the existing offline mechanical admission from exact P. Only the coordinator creates and pushes the real tag after it passes.

Catalog stories and Worker qualification remain post-publication. Published rc.7 host verification must first establish positive NanoHost readiness for #248, then exercise fresh registry Worker preparation for #242. Neither replaces R001 or proves the whole release cycle complete. This task contacts no deployment host.

## Change Surface And Status

The preparation adds notes and this record, plus three minimum status-line corrections in the release owner/cookbook. The four-attachment criterion and delayed-manifest condition do not change. No code, package version, workflow, new registry or durable state is added. Independent review and final publication remain pending.

The first dependency install failed because shared `/tmp` exhausted inodes. Moving only this task's fresh worktree to the disk filesystem and retrying the frozen install corrected setup. No other task data or retained release evidence was removed. Disposable test files use task-owned disk-backed temporary storage. No setup failure is counted as a passing check.
