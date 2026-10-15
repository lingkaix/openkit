---
type: change-plan
status: in-progress
date: "2026-10-15"
started: "2026-10-15"
branch: release/v0.1.0-rc.8-prep
---
# v0.1.0-rc.8 Prerelease Preparation

This record preserves preparation and missing release evidence. It supplies no design authority or publication authorization. [Release Management](../../specs/20260829-release_management.md), the [Release Cookbook](../../cookbooks/release.md), [Test Strategy](../../specs/20260529-test_strategy.md), [L6 Story Acceptance](../../specs/20260529-l6_story_acceptance.md), [Persistent Deployment Acceptance](../../specs/20260909-persistent_deployment_acceptance.md) and the [standing scratch grant](../../decisions/20261015-standing_scratch_rehearsal_grant.md) govern this work.

## Intent

### Intent Revision 1 — 2026-10-15 (UTC)

Source: the coordinator selected a new rc.8 release after the rc.7 App smoke failure. The independent Astra route review, dated 2026-10-16, agreed with conditions. This preparation implements conditions 1, 2, 7, 8 and 9. Preserve rc.7 as a partial publication. Start from its failure record, carry the product scope from the last complete release rc.6, and add only the focused native-smoke correction and required release documents. Keep train 1 outside the candidate. The cadence writer owns the fix and scratch rehearsal on `release/v0.1.0-rc.8-native-smoke` from the rc.7 source; this writer owns only the rc.8 notes and this new record. Draft, obtain one independent review, and push only the prep branch. Do not tag, publish, update a deployment or touch main in this phase.

The coordinator will provide the exact reviewed fix head. Then apply these preparation commits on that head as patch-identical commits, freeze candidate P, obtain independent combined-P review and run `check:repo` through the machine-wide slot wrapper. The coordinator owns the exact-P full main-push gate and fast-forward of main. No release admission, tag push, scratch action or host effect is authorized by this drafting task.

## Preparation Checkpoint — Rewritable

| Field | Current fact or missing gate |
| --- | --- |
| Intended identity | `v0.1.0-rc.8`, non-draft prerelease, never GitHub Latest; GHCR Latest remains unchanged |
| Last complete release | `v0.1.0-rc.6`, source `0aa3f9a24e4cd0fdbec36b8d5f72d374a0086b3c`. Assess cumulative product and story impact against this release and the actual deployed bytes |
| Partial predecessor | `v0.1.0-rc.7`, immutable source `fcbb9978aa9f0967551da4a0d808d043e087075c`. Not a complete or installable predecessor |
| Prep branch base | Failure-record commit `7d3cdf43d6644867a6dfb5ee3f94cb85c75deca5`; preserves the rc.7 failed boundary without changing its tag or published Worker identities |
| Fix branch | `release/v0.1.0-rc.8-native-smoke`, based on rc.7 source; writer Release cadence v2, agent `8a8d63cf`. Exact final head and successful rehearsal are not yet supplied |
| Tested T / publishing P | Not frozen. No previous run, including rc.7 CI, qualifies the future P. Any later commit changes P and requires exact-P review and candidate CI |
| Included scope | Cumulative rc.6-to-rc.7 product scope, focused native-smoke fix with regressions and required projections, rc.7 failure record and rc.8 release documents. Exclude the wider cadence-v2 implementation and train 1 |
| Assets | Three catalog release images built for the new P; operations Skill archive; native amd64 and arm64 NanoHost archives; `SHA256SUMS`. Four portable attachments. No machine-readable manifest asset is added here |
| Authority | Standing prerelease grant is conditional on current reviewed P in main, exact-P candidate evidence, publication-path proof, complete blocker reconciliation, unused identities, fixed flags and current private admission evidence |
| Visibility | rc.7 observations recorded public repository and anonymous Worker-base access. Reobserve repository and package access before rc.8 admission; no visibility change is authorized |
| Strict-risk dispositions | Existing 2026-10-15 engineer rulings admit disclosed #223 and #249 for prereleases, with closure required before first stable. Both stay unlabeled; this task makes no new strict-risk decision |
| Host results | #248 source correction and #242 registry correction are included; published rc.8 positive readiness and registry-path observations remain unproved. R001 remains open |
| Current frontier | Draft notes and plan approved by the independent reviewer; focused draft checks passed. Native fix, rehearsal, combined-P review, exact-P gate, admission, tag, publication verification and post-publication results remain pending |
| Next action | Hand off the reviewed prep branch and await the coordinator's exact focused-fix head before integration |

## Retained rc.7 Failure And Selected Correction

The [rc.7 failure record](../202610150713000000-v0_1_0_rc_7_prerelease/plan.md#publication-attempt-and-failure--2026-10-15-utc) remains unchanged. [Tag run 38735832117](https://github.com/lingkaix/openkit/actions/runs/38735832117) failed after both Worker images were promoted. App promotion, GitHub Release creation and published-release verification did not run. No App release image or GitHub Release exists in the retained partial-publication observation. The digest-only App candidate is not a released App image. Do not create an empty release or present rc.7 as an installable update predecessor.

The diagnosis reproduced the exact CI QEMU 10.2.3 behavior: the address-space setter returns success but does not apply the ceiling. Native amd64 enforced the same limit. This explains the failed emulated observation; it proves neither a native arm64 product pass nor a defect in either promoted Worker. The fixed limit assertions remain required. Diagnosis and probe evidence are retained outside the repository under evidence alias `rc7-arm64-smoke-diagnosis`; the independent route review is `consultant-rc7-route`.

### Historical rc.7 Worker Identities

The following index digests are historical evidence copied from the rc.7 failure record's 2026-10-15T13:47:43Z observation. Each had complete rc.7, version-without-v and source-revision tag sets. Preserve them unchanged; they qualify no rc.8 build, smoke or Worker case.

| Image | Historical rc.7 index digest |
| --- | --- |
| `openkit-worker-common` | `sha256:aab2af6eb9712e72640d52f67057d81002c377f32cb94e9b8c6440fd75b74268` |
| `openkit-worker-runtimes` | `sha256:4393146e3fd1aae15274b63f8755c6cfcfa8762c28b2aaefb922611d16a5d3de` |

rc.8 builds and publishes its Worker images normally for new P with their own release tags and source attribution. Do not retag rc.7 images, require equal digests, or use rc.7 promotion as rc.8 qualification. Build-cache reuse is not immutable release proof.

The coordinator selected a new P and rc.8 rather than a same-tag retry. The original rc.7 source and tag stay fixed. The independent review requires a focused native App smoke slice, actual host/daemon architecture validation outside the image, exact candidate/manifest binding and promotion only after both platforms pass. The cadence owner supplies its implementation, regressions and actual scratch proof. This record makes no claim that those pending results already exist.

## Cumulative Product Scope Since rc.6

Carry all [rc.7 product scope](../202610150713000000-v0_1_0_rc_7_prerelease/plan.md#included-work-since-rc6) into rc.8 notes. The rc.7 tag does not make that scope delivered to users as a complete release.

- Staged native startup (#245): FIFO cold-start admission, at most two concurrent starts bounded by CPU affinity and quota, without lowering the separate active-Turn bound or ordinary RPC ceilings. #246 is a separate unresolved one-CPU OpenCode close-proof failure.
- Retrieval Kernel R2: supervised native kernel service, lexical/exact/regex retrieval with Chinese and Japanese matching, qualified source references, trusted query context, query-owned write-once traces, pre-Turn trace references and owner/remint-aware export/import. The App supplies the native kernel, verified dictionary bytes and available dependency notices.
- NanoHost #248: `h2` ALPN with both verified trust sources, one absolute 120-second TCP/TLS/HTTP2/admission deadline and invalidation on initial TCP expiry. Fixed in source, pending positive ready generation from the published rc.8 artifacts.
- R2 CI/build corrections: qualified-reference coverage, kernel build before NanoCore to correct the L5 Task Knowledge 409, and verified dictionary inputs in image fixtures. No lowered coverage threshold or retrieval fallback.
- Shared-conversation decision and core-experience planning are records, not a delivered shared-conversation feature. #247 remains after `v0.1.0` and the private Timeline.
- New correction relative to rc.7: native platform App smoke before promotion, preserving actual resource-limit enforcement assertions. Exact focused-fix commits and rehearsal will be recorded when supplied.

## Known Issues And Reconciliation

The [rc.7 reconciliation](../202610150713000000-v0_1_0_rc_7_prerelease/plan.md#known-issues-dispositions-and-disclosure) retains 98 open-issue dispositions at its recorded observation, derived from the [rc.6 initial reconciliation](../202610131730000000-v0_1_0_rc_6_prerelease/plan.md#initial-release-blocker-reconciliation). It is historical input, not current rc.8 triage proof. Carry its applicable owner, disposition and disclosure rows, then reconcile all live open issues and updates again before freezing P and admission. Any new strict-risk acceptance or unresolved applicable blocker goes to the engineer. Label absence alone proves nothing. No label or issue write is authorized here.

| Finding | Owner / accepted disposition | rc.8 disclosure and missing observation |
| --- | --- | --- |
| #223 | Work Data Retention; [2026-10-15 engineer ruling](../202610150713000000-v0_1_0_rc_7_prerelease/plan.md#223-all-prereleases-before-the-first-stable-release) applies to all prereleases before first stable `v0.1.0` | Disclosed non-blocker for rc.8; first-stable blocker, unlabeled. Power loss can lose records without synchronization. Pre-stable reset requires its separate accepted procedure and protected-account checks |
| #249 | Retrieval Kernel notice supply; [engineer ruling](../202610150713000000-v0_1_0_rc_7_prerelease/plan.md#four-notice-gaps-disclose-for-prereleases-close-before-stable) permits disclosure for prereleases | Four gaps: `htmlescape 0.3.1`, `kanaria 0.2.0`, `winapi-i686-pc-windows-gnu 0.4.0`, `winapi-x86_64-pc-windows-gnu 0.4.0`. First-stable blocker, unlabeled. Supplied notices and `GAPS.json` do not claim complete provenance |
| #248 | NanoHost Runtime; existing source-fix/pending-host disposition | Keep open until published rc.8 NanoHost reaches a positive ready generation on a real host. Source regressions and scratch smoke are not this proof |
| #242 | NanoHost registry preparation; existing pending-host disposition | Verify fresh registry preparation after rc.8 positive readiness. rc.6 stopped before readiness and registry preparation was not attempted |
| #120 / R001 | NanoHost Runtime and Release Management | Archives are installable; supported Worker Agent execution is not release-ready. Exact-product no-host-reboot evidence remains required; stable remains blocked |
| #246 | OpenCode Adapter | One-CPU drain/persistence-flush failure after twenty concurrent Turns. Keep failure visible; no retained-native-state readiness claim |
| #195 | Release installation guide | Carry incomplete release-only install guidance disclosure; plan a real published-asset story 1 without claiming a pass |
| #247 | Shared-conversation decision | Deferred until after `v0.1.0` and private Timeline; design only |
| #177 and remaining rc.7 disclosures | Existing owners and carried reconciliation | All applicable known issues remain in the rc.8 notes. Recheck closure, new issues and post-snapshot updates before admission |

Stable prerequisites #225 and #240 remain unresolved. #241 manifest publication remains outside this focused correction. No stable gate or issue closure is inferred from the native-smoke fix.

## Release Plan And Evidence Gates

1. Integrate only after the coordinator supplies the exact focused-fix head. Apply these prep commits above it as patch-identical commits, retaining the rc.7 failure-record commit. Compare the integrated diff against rc.7 P to exclude unrelated cadence or product work. Resolve every full Git identity from `git rev-parse`; mechanically check references before handoff. Freeze notes, owner projections, controlled asset set and checklist blob identities with candidate P.
2. Obtain independent `gpt-6.1-sol` review of the exact combined P, with verdict alias `reviews/RC8-<short-sha>.md`. Run `pnpm run check:repo` through `/home/simonx/AI/temp/backlog-20261015/bin/run-slot.sh`. A draft review or previous CI run does not qualify this combined P. Any subsequent commit changes P and requires refreshed exact-P evidence.
3. Retain the cadence owner's successful scratch run in existing `notrucked/openkit` under the standing grant. Read the actual job results. Compare P's publication job blocks and invoked input closure using the existing publication check against the successful rehearsed source. Record per-input Git identities, aggregate comparison, native host/daemon architecture and candidate/index binding. The rehearsal must cover the selected focused fix, both native App smokes and the unchanged assertions, including proof that omitting the address-space setter fails without an inherited limit masking it. Earlier rc.6 success or the QEMU probe supplies none of this changed-path proof. No scratch action belongs to this draft writer.
4. The coordinator fast-forwards the reviewed candidate into main and runs the fresh successful exact-P main-push release gate. Retain run URL, event, exact head, latest-attempt job identities and every required successful gate result. A branch run or a run on a nearby commit does not replace the requested main-push gate. Required job failure stops publication; do not bypass or retry without the applicable direction.
5. Refresh private admission observations from actual sources on exact P: review, main membership, successful candidate jobs, successful rehearsed path and immutable Git comparison, applicable unrevoked standing grant, controlled assets and fixed non-draft prerelease flags. Reconcile live open issues and all new or updated findings with owner, applicability, disposition and disclosure. Stop for an applicable blocker or missing engineer decision. Confirm `release-blocker` exists; do not alter #223 or #249 labels.
6. Prove unused rc.8 identities immediately before admission: no rc.8 tag or GitHub Release, and no exact-version, version-without-v or source-revision tag for any required image at P. Record GitHub Latest and every GHCR Latest baseline for equality after publication. Retain repository/package access posture and anonymous Worker-base proof without changing visibility or credentials. An unexpected existing immutable identity stops this new-release route; do not reinterpret it as an authorized retry.
7. Run release preflight and `node scripts/release-publication-check.mjs <private-evidence-file>` from clean exact P with Node 24.18.0. Evidence remains mode 0600 outside the repository, contains no credentials and declares its observation time and validity window. Missing or conflicting evidence refuses. A valid check establishes eligibility under the grant, not a new authorization.
8. Only the coordinator or a separately dispatched authorized publisher pushes the new lightweight `v0.1.0-rc.8` tag on admitted P. Confirm the remote tag and tag-run source before the held train advances. Do not move main, reuse rc.7's source identity, rewrite an existing tag, retag its Workers or rerun its failed publication. This draft task creates no tag.
9. Watch the entire tag run to completion. Retain stage timestamps from the exact-P gate start through verified publication. Native App smoke must qualify both actual candidate platforms before promotion; every ordinary rc.8 Worker follows normal new-P build/smoke/publication. Verify each image's recorded index/platform identities, source attribution and immutable tag trio, anonymous Worker-base access, all four controlled attachments and portable checksums, the operations archive's reviewed helper bytes, extracted operation discovery and both NanoHost archive checks. Verify non-draft prerelease state, no GitHub Latest assignment and unchanged GHCR Latest. Do not call a tag push or partial matrix success release completion. Failure preserves all immutable identities and records the exact stopped boundary for the coordinator.

## Post-Publication Work — Separate Results

After verified rc.8 publication and successful local tests, the coordinator dispatches the authorized deployment work. This preparation contacts neither deployment host, installs nothing and runs no live qualification.

- Development-machine installation: run story 1 from the public repository and the actual published rc.8 assets, with no source checkout in the Actor's flow and no disposable VM. Keep the installed deployment on the machine. Preserve designated-account usability and any separately authorized pre-stable reset boundary.
- Deployment update: use one explicit authorized target with retained binding; exclude production `a2`. Keep App prepare/preflight/start/status, NanoHost replacement and Worker preparation/activation results independent. No warm-image inference, automatic repair, unknown-effect retry or unassessed data reset.
- Host proof: retain the exact published NanoHost identity and positive ready generation for #248. Then prove fresh registry preparation for #242 on those rc.8 artifacts. Missing, failed or inconclusive observations remain unproved under their existing dispositions; a scratch App restart establishes neither result and closes neither issue.
- Worker qualification: after the authorized deployment update, run all sixteen A–D cases for the four runtimes, concurrent groups within admitted capacity and sequential cases in each group's Thread. Bind evidence to the actual published rc.8 component identities. A rc.7 Worker digest, packaging pass or scratch smoke supplies no case verdict. Retain wrong/stale/empty/refusal and all other non-pass results; do not retry unknown mutations blindly.
- Affected stories: assess the whole cumulative scope against rc.6 and the actual earlier published deployment, never against rc.7 as a complete predecessor. Preserve release-cycle coverage and change-driven installation, update and operator-guidance stories. The initial dev installation uses story 1. Select story 2 only on a real earlier published release with its data, subject to the accepted pre-stable reset rules. Independent Actor/judge separation, the shared story browser preflight and current run-consistency rules remain required. Do not rerun every story solely because the workflow changed; record selection and remaining coverage.
- Stable readiness: keep R001, #223, #249 and all other first-stable obligations separate. Worker qualification and story evidence count only under their owners. No stable promotion is authorized here.

## Verification And Handoff

Draft validation used Node `v24.18.0` and `/home/simonx/AI/temp/backlog-20261015/bin/run-slot.sh`, holding one slot. Exact results, all exit 0:

- `node scripts/validate-doc-model.mjs`: `Validated documentation model (487 documents).`
- `node scripts/validate-spec-lifecycle.mjs`: `Validated spec lifecycle metadata.`
- `node scripts/generate-doc-index.mjs --check`: `Documentation index is current.` No generated index edit was needed.
- Focused `pnpm exec biome check --no-errors-on-unmatched` on the two draft Markdown paths: `Checked 0 files in 3ms. No fixes applied.` The current Biome configuration does not check Markdown; this is not a Markdown lint pass. Documentation validation and the independent review cover the text.
- `node --test tests/release-notes.test.mjs tests/release-preflight.test.mjs tests/release-publication-check.test.mjs`: `tests 124`, `pass 124`, `fail 0`, `cancelled 0`, `skipped 0`, `todo 0`.
- `node scripts/release-preflight.mjs --repo-root . --tag v0.1.0-rc.8`: `Release preflight passed for 0.1.0-rc.8.` and `Release images: app, worker-common, worker-runtimes`.
- Actual rc.8 input: `readReleaseNotesInput(process.cwd(), "v0.1.0-rc.8")` returned successfully with `Actual rc.8 notes parser: PASS.`
- `git diff --cached --check`: exit 0, no output.
- Mechanical identity guard: all three full Git commit references resolve with `git cat-file -e <sha>^{commit}`; every historical OCI digest matches the retained rc.7 record. All 81 known-issue references from rc.7 notes remain in rc.8 notes. Notes retain exactly the required two top-level sections; confidential-content guards passed.

Independent `gpt-6.1-sol` draft review returned `APPROVED. No actionable findings.` External verdict alias: `reviews/RC8-drafts.md`. The reviewer inspected both actual draft files, exact known-issue retention, historical digests, commit identities, local link targets and staged whitespace. Approval covers the drafts only. Combined-P `check:repo` remains due after focused-fix integration. No native-smoke, scratch, combined-P, exact-P main-push, admission, publication or live result is claimed by a draft check. Preserve rc.7 notes, its failure record and all existing public identities unchanged. The only new repository paths in this preparation slice are this plan and `release-notes/v0.1.0-rc.8.md`.
