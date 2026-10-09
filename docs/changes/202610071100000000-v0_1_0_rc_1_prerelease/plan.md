---
type: change-plan
status: planned
date: "2026-10-07"
branch: rel-prep
---
# v0.1.0-rc.1 Pre-Release Preparation

This record preserves preparation and eventual verification evidence for the first pre-release. It adds no rule or authorization; [Release Management](../../specs/20260829-release_management.md), [Foundation](../../core/foundation.md), and their linked owners govern the work, with the [Release Cookbook](../../cookbooks/release.md) supplying the procedure.

## Intent Epoch 1 — 2026-10-07

**Source and outcome.** The engineer's 2026-10-07 instruction to the coordinator, reproduced under Publication Authorization below, authorizes completing dogfooding, correcting defects, and publishing and verifying immutable pre-release `v0.1.0-rc.1` from one exact `main` commit.

**Non-negotiables and exclusions.** Preserve retained data and protected configuration under their owners. Never move, delete, force-push, overwrite, or replace a published tag or asset; a defective or ambiguous promoted artifact requires a new version on a new commit under the release owner's authorization boundary. Stable release is excluded and unauthorized. A prerelease leaves GHCR `latest` and GitHub Latest unchanged. Repository or package visibility changes and external publication outside the repository release workflow are excluded.

**Acceptance.** The unchanged candidate and frozen scenario revision prove the release owner's required consecutive complete clean rounds, currently two, with every defect classified and linked and no unresolved applicable blocker waived. The tag workflow, including its deciding `Verify published release` job, is green. The published GitHub Release is non-draft and prerelease, identifies the tested source commit and workflow run, contains exactly the four controlled attachments below, and records image digests, visibility, manual-gate disposition, checksums, and the NanoHost limitation. Every version image resolves to its recorded digest; prerelease Latest pointers remain unchanged. Downloaded portable checksums and Skill inspection/discovery pass, both NanoHost archives pass the shared verifier and contained staging, and the exact `worker-common` digest is anonymously inspectable after registry logout. These observations project [Verify And Close](../../cookbooks/release.md#verify-and-close) and [Post-publication Verification](../../specs/20260829-release_management.md#post-publication-verification), rather than replacing them.

**Effect boundary.** The coordinator's release work covers authorized dogfooding on the persistent staging deployment, bounded defect correction, repository review/merge, and the named pre-release tag workflow and its controlled bundle. Scenario-specific Provider consumption, GitHub writes, and Pending Request decisions retain their existing effect-specific authority.

**Completion truth.** This preparation record establishes no release readiness, counted round, publication, independent acceptance, or engineer-reserved gate. Release completion remains unproved until the retained observations above exist; the coordinator fills the pending sections and sets lifecycle status from actual evidence.

## Preparation Checkpoint — Rewritable

| Field | Current fact or pending observation |
| --- | --- |
| Intended tag | `v0.1.0-rc.1` |
| Source commit | **PENDING — coordinator freezes the full exact clean `main` commit before counted round 1, proves containment in `origin/main` and that no earlier release used it, and publishes that same commit.** |
| Repository visibility at preparation | At `2026-10-07T11:19:02Z` the coordinator ran `gh repo view lingkaix/openkit --json visibility,isPrivate` and got `{"isPrivate":false,"visibility":"PUBLIC"}`. |
| Package visibility and release posture | **PENDING — coordinator records observed visibility of all three release packages, absence where not yet created, and private/controlled/public release posture before publication.** Only `worker-common` has an anonymous-public contract; visibility mutation is separate authorization. |
| Non-publishing tag-only preparation chain | On 2026-10-07, release preflight, native NanoHost builds on amd64 and arm64, portable packaging, hosted NanoHost qualification on both targets, and packaged-asset verification passed in [GitHub Actions run 37611578953](https://github.com/lingkaix/openkit/actions/runs/37611578953), after commit `3daf363e` fixed packaging and verification defects. The coordinator reports that the temporary probe branch disabled every publication job and was deleted afterwards. Image publication, promotion, GitHub Release creation, image-digest verification, and anonymous `worker-common` pull were not exercised. |
| Method and frontier | Complete normal preparation/review, reconcile earlier defects, freeze candidate and checklist, and run the fixed scenarios through [Persistent Live Acceptance](../../cookbooks/persistent-live-acceptance.md). Published artifacts are rebuilt from the tested commit; deployment and publication bytes are not claimed identical. |
| Next Action prediction | Coordinator reconciles current Git and defect evidence and freezes the candidate, scenario inputs, and manual-gate decisions. Expected observable: a reviewable exact-candidate checkpoint and checklist; unresolved blockers or a changed candidate prevent carrying forward a clean-round count. |

### Expected Bundle

The current [image catalog](../../../containers/images.json) declares `app` (`openkit-app`), `worker-common` (`openkit-worker-common`), and `worker-runtimes` (`openkit-worker-runtimes`) as release images, each for `linux/amd64` and `linux/arm64`. Only `worker-common` declares anonymous pull. `test-env`, the internal dogfood image, private npm workspace packages, and GitHub-generated source archives are excluded from controlled release assets.

The four portable attachments, confirmed against [CI](../../../.github/workflows/ci.yml), are `openkit-ops-skill-v0.1.0-rc.1.tar.gz`, `openkit-nanohost-v0.1.0-rc.1-linux-amd64.tar.gz`, `openkit-nanohost-v0.1.0-rc.1-linux-arm64.tar.gz`, and `SHA256SUMS` covering all three archives. The Skill includes the repository license and complete operations package with its generated administrator executable; NanoHost archive contents remain owned by the NanoHost specification.

### Manual-Gate Disposition

**Selected by the accepted release owner:** the fixed 21-scenario persistent-deployment rounds and their clean-round criterion, including all sixteen real-runtime cases, supported deployment, Chat, Task, Goal, and independent external-Agent discovery. Missing required execution or public evidence remains incomplete. Scenario selection does not enlarge effect authorization.

**Coordinator decisions:** select L4 Web e2e through the candidate's CI `workflow_dispatch` run with `gate=full`. The current workflow's `web-e2e` job condition selects that event with either `web-e2e` or `full`, and runs `pnpm -w test:e2e:web`. Keep formal L6 story acceptance and separate real-provider, real-subscription, and real-worker opt-in suites unselected beyond the selected scenarios. The [cookbook](../../cookbooks/release.md#prepare-the-release) leaves these additional confidence checks to the release decision; the selected real-use rounds already exercise the first-release journeys. These are coordinator choices, not engineer rulings. The external-Agent scenario still requires Actor isolation, actual MCP observations, and independent recomputation; omitting formal L6 adds no operator-only shortcut. Record any changed selection and its exact evidence here.

The [2026-10-05 ruling](../../decisions/20261005-first_release_lifecycle_and_verification_scope.md) selects existing heartbeat/barrier regressions and targeted observed-failure cases, defers the broader four-protocol fault program and physical full chain, and places dual-architecture distribution qualification only in release/pre-release hosted CI. It retains dogfooding, platform stability, data integrity, and the release exit criterion. Hosted distribution qualification and automatic L0–L3/L5 gates remain required; no local host result substitutes for them.

### Known Limitations And Open Questions

The [2026-10-09 blockers-only triage ruling](../../decisions/20261009-rc1_blockers_only_triage.md) requires fixing newly found rc.1 defects only for work that gets stuck, data loss or corruption, security or authorization problems, or a wrong terminal state or a false success; non-blockers require a GitHub issue and release-notes disclosure without an extra counted round, while accepted round judgment, gates, CI requirements, the stable-release block, and effect authorization remain unchanged.

**Filed post-acceptance backlog:** the [backlog index #177](https://github.com/lingkaix/openkit/issues/177) tracks the issues the release notes must disclose: [#120](https://github.com/lingkaix/openkit/issues/120) R001 Worker readiness proof; [#121](https://github.com/lingkaix/openkit/issues/121) live Task steer not implemented; [#122](https://github.com/lingkaix/openkit/issues/122) user-selected shared Sandboxes not implemented; [#123](https://github.com/lingkaix/openkit/issues/123) required-compaction failure classification; [#124](https://github.com/lingkaix/openkit/issues/124) upstream historical tool-pair acceptance unproved; [#126](https://github.com/lingkaix/openkit/issues/126) existing authored npm grants need administrator update; [#127](https://github.com/lingkaix/openkit/issues/127) Chat tool-call declaration parity; [#128](https://github.com/lingkaix/openkit/issues/128) bounded Task completion versus objective completion; [#130](https://github.com/lingkaix/openkit/issues/130) Pi self-stop incident unproved; [#131](https://github.com/lingkaix/openkit/issues/131) tool-download network grants; and the already-open [#117](https://github.com/lingkaix/openkit/issues/117) D7 schema guard granularity, [#108](https://github.com/lingkaix/openkit/issues/108) subscription login recovery residuals, and [#116](https://github.com/lingkaix/openkit/issues/116) release cookbook says private.

**R001 remains open:** exact-product no-host-reboot Worker runtime readiness is unproved. NanoHost archives are installable, but supported Worker Agent execution is not yet release-ready; stable preflight remains blocked. CI's generated notes disclose both installable targets and the open R001 gate; post-publication inspection checks that disclosure rather than treating installation as runtime qualification.

**Q-REL1 remains unresolved:** first `openkit-worker-common` publication creates a private GHCR package. The anonymous exact-digest check stops the tag run before GitHub Release creation until the engineer authorizes and performs the separate public-visibility change. The coordinator's proposed route is to retain the partial publication and failed predicate, obtain that disposition, and rerun the failed jobs on the same tag, reusing proved immutable images. This record neither authorizes the visibility change nor marks the pre-release complete while that predicate fails.

**Earlier qualification is not release readiness:** round 35 retained queue/receipt/closeout and Workspace materialization failures, with thirteen failed runtime cases, three incomplete follow-ups, and zero runtime-matrix passes. Its original unknown attempt and missing observations remain evidence; a later fix needs new candidate-bound observations. No counted release-round results exist in this record.

**Cookbook projection discrepancy:** Publish and Verify And Close still refer to two archives plus checksums, and `docs/cookbooks/release.md` line 15 still says the repository is currently private despite the coordinator's public-visibility observation above. The accepted release owner and current workflow require three archives plus `SHA256SUMS`; this record uses that four-attachment composition and reports the stale wording without editing the cookbook.

## Publication Authorization

Engineer wording supplied to the coordinator on 2026-10-07, quoted verbatim:

> 「dogfooding的PR不要我来审核和合并……使用我们已经部署在A2上的这个实例完成 dogfooding。 如果中途遇到缺陷和错误，那么就修复。最后的pre-release也不需要我授权你，你走完发布流程，确认都成功就可以了。」

This authorization applies to the first pre-release `v0.1.0-rc.1`; the coordinator records its application to that exact tag and bundle before publication. No additional engineer authorization is requested for this named pre-release. Stable release remains unauthorized, and publication outside the repository release workflow, including changing GHCR package visibility, is excluded.

## Pre-Release Execution-Authority Cutover

The engineer approved route B on 2026-10-06, including a fresh data root for cutover with old execution fenced. Source evidence is the uncommitted engineer queue, lines 228–232. The governing procedure is [Pre-Release Execution Authority Cutover](../../cookbooks/persistent-live-acceptance.md#pre-release-execution-authority-cutover), with execution semantics owned by [Worker Runtime Communication Model](../../specs/20260629-worker_runtime_communication_model.md).

Round 35 on 2026-10-07 deployed the selected fresh root on the persistent staging deployment through ordinary installation after stopping the predecessor and proving whole selected effect-domain absence. The old root, configuration, protected credentials, and evidence remained offline under existing custody. Fresh trust and enrollment were established without adopting the old execution baseline or restoring old execution sessions. The report records successful installation/bootstrap and initial public NanoHost readiness with predecessor fencing and fresh-empty state, with exact source/artifact attribution retained in its ordinary evidence.

Source: uncommitted round-35 operational report, Progress 11, 12, 16, 28 and Final qualification and handoff. Overall qualification failed; at round 35 close the fresh installation was deliberately stopped and fully fenced, both roots were retained offline, and the original unknown attempt was preserved. The same round-35 fresh root was later resumed through same-root upgrades in rounds 36 and 37 and now serves dogfooding on the persistent staging deployment. The cutover evidence does not qualify the future release candidate or contribute a clean release round.

## Frozen 21-Scenario Checklist — Pending Coordinator Entry

**PENDING — no checklist or inputs frozen yet.** Record the exact Git revision of `docs/cookbooks/release.md`, candidate commit, approved deployment identity, non-secret configuration identities, selected issue inputs, acceptance branch/base, runtime/model selections, attempt-owned names, filenames, markers, expected outcomes, and deciding public records. Append the full 21-scenario checklist from that revision; this empty section is not the frozen set.

## Ordered Round Results — Pending Coordinator Entry

**PENDING — no counted rounds executed or adjudicated here.** Retain round UTC windows, checklist revision, supported deployment receipts and component identities, all scenario inputs and public evidence with complete read coverage, distinct failure causes after redaction, correlated HTTP 502/reset observations and coverage, cleanup, defect references, separate outcome counts, and clean-count/reset reasoning under [Record And Classify Every Round](../../cookbooks/release.md#record-and-classify-every-round).

| Round | Candidate commit | UTC window / checklist revision / deployment evidence | Per-scenario pass/fail/incomplete and classification / evidence | Outcome counts / consecutive clean count / reset reason |
| --- | --- | --- | --- | --- |

## CI Run On Candidate — Pending Coordinator Entry

**PENDING —** candidate commit, `workflow_dispatch` run URL/id with `gate=full` including selected L4 Web e2e, exact terminal results and retained outputs; no final-candidate full-gate success claimed. The earlier non-publishing tag-only preparation chain is recorded separately in the checkpoint.

## Tag Workflow Run — Pending Coordinator Entry

**PENDING —** exact tag/commit, run URL/id, hosted qualification, packaging, image smoke/promotion digests, Latest observations, anonymous gate, partial-publication boundaries, authorized visibility disposition, same-tag reruns, and deciding verification result; no tag or publication claimed.

## Independent Post-Publication Verification — Pending Coordinator Entry

**PENDING —** observer and UTC time, fresh GitHub Release read, exact attachments, downloaded checksums, Skill inspection/discovery, both NanoHost verifier/staging results, recorded versus observed image digests, anonymous exact-digest inspection, repository/package visibility, unchanged Latest pointers, manual-gate disposition, and generated-note limitation. Record independent deciding observations, not only producer summaries.

## Closeout — Pending Coordinator Entry

**PENDING —** delivered changes and commits, exact verification, external effects, cleanup and retained state, unresolved findings and residual risks, acceptance disposition and lifecycle status. Record raw complexity numbers under [Change Records And Retention](../../change-execution.md#change-records-and-retention): files changed, owning documents changed, distinct owners touched, and any closed set or registry added; no values are invented at preparation.
