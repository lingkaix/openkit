---
type: change-plan
status: in-progress
date: "2026-10-16"
started: "2026-10-16"
branch: lane/ops-p15
---
# P15 Manifest Attachment And Stable Promotion

This record is execution evidence. Release Management owns the release contract and authorization. The coordinator's bounded synthetic exception is recorded in the same change's decision record; this record grants no effect.

## Intent

### Intent Revision 1 — 2026-10-16

The coordinator assigned P15 to L-OPS after the published rc.8 a1 Worker diagnosis. Implement manifest attachment and downloaded verification in the existing publication path; prove stable promotion of already-published prerelease indexes and archives without rebuilding; retain exact source, retry and negative evidence. Follow the lane landing protocol and keep production stable publication reserved. Do not touch a1 NanoHost or submit its Worker Turns; L-RT owns D-RT-5.

After OPS identified the prerelease-only scratch grant, the coordinator granted exactly one synthetic stable rehearsal in the existing experimental repository and its own packages: one unused stable tag on the already-published synthetic prerelease commit, its Release and scratch-only Latest changes, one immutable retry and a no-write negative check. Rehearsal-only fixtures do not close R001 or real first-stable prerequisites. No production stable or Latest, production preflight-default change, new scratch owner, visibility or credential change is admitted. See [the decision record](../../decisions/20261016-bounded_stable_promotion_rehearsal.md).

## Checkpoint

The manifest remains strict: the reviewed six-fact assessment is committed before source freeze, then the producer joins the exact source and published App index. Missing, negative or unassessed facts stop the tag preflight. The three archive checksums go in the manifest, and the shared checksum additionally covers the manifest without a circular self-checksum. Existing four-asset releases are unchanged.

Stable promotion uses the same commit and copies the prerelease's five attachment names and bytes. Its title and image version tags identify the stable promotion. The source manifest and archive provenance stay with the prerelease. The source run must be its current successful tag attempt, including all image publication, native App smoke and final verification jobs. Partial stable tags, conflicting digests, unknown outcomes or superseded Latest refuse. The production prerelease-only default remains hard; the separate tag-only stable workflow refuses outside the bounded synthetic repository and version family.

The publication-input proof now covers the stable workflow and its static dependency closure. Existing notes bytes remain unchanged. The only deliberately changed CI publication jobs are github-release and verify-release; their byte guards are re-recorded for the fifth attachment and reconstructed download check. Every other frozen job block remains checked.

## Validation And Rehearsal

Focused producer, preflight, promotion, workflow and offline admission suites initially passed 272 tests with zero failures or skips. The earlier frozen-job run observed exactly the two intended publication-pin failures before those pins changed. The repository gate passed before the canonical-tag correction. The Python helper suite passed 88 tests. The initial independent review found a mismatch between the manifest parser and canonical prerelease grammar; the correction reuses the canonical parser and adds a regression. Its focused suite passed 86 tests, and independent review passed 214 checks and approved the corrected implementation. Final rebased-head gates and review remain required; do not infer them from this implementation report.

The protected lane checkpoint and raw receipts remain outside the repository in the coordinator's evidence store. Later frozen commit identities and gate results are recorded there; this record does not predict them.

## Bounded Rehearsal Evidence

The independently reviewed synthetic source is `3d33fe336680c77ca2e6ed3e30f6033704151bb3`. Its only fixture additions are the synthetic prerelease notes and six-fact assessment; both explicitly exclude product compatibility, retained-data, host, Worker and stable-eligibility claims. The source and corrected implementation have identical publication inputs: 12 job/workflow entries and 54 files, aggregate `d7862f0d25eba1aaf02be76c6f5336f7ccbac02e565abad5db5a00e9771843cb`. Invoked notes-generator bytes remain unchanged.

| Observation | Actual result |
| --- | --- |
| [Exact-source full candidate CI](https://github.com/notrucked/openkit/actions/runs/38882208081) | Passed, including registry admission; 22 minutes 47 seconds. |
| [Synthetic prerelease publication](https://github.com/notrucked/openkit/actions/runs/38884900441) | `v0.0.16-p15.1` passed both native App smokes, five-asset publication and final download verification; 13 minutes 12 seconds. |
| [Synthetic stable promotion, attempt 1](https://github.com/notrucked/openkit/actions/runs/38886480578/attempts/1) | `v0.0.16` points to the same source. Fresh promotion passed without builds; the same three image indexes and five attachment hashes were verified; 2 minutes 6 seconds. |
| [Immutable same-tag retry, attempt 2](https://github.com/notrucked/openkit/actions/runs/38886480578/attempts/2) | Passed in reuse mode. Release identity, five asset identities and hashes, image indexes and scratch Latest remained equal. The retry made no image or Release write. |
| No-write negative retry | A simulated superseded image Latest value, derived from retained actual publication observations, refused before any write adapter. No live Latest value was changed for this negative check. |

Independent local downloads passed all four checksum entries. The stable attachments retain the source prerelease filenames and bytes; no archive was renamed or repacked. The source manifest retains the source prerelease provenance. Both actual tag workflows ran at the exact synthetic source. The normal full candidate dispatch supplies the exact-source candidate proof; the redundant automatic scratch main run was cancelled and supplies no evidence. Local private scratch registry reads were unauthorized and were never treated as absence; the successful job-scoped registry admission and promotion checks supplied those observations.

The protected P15 receipts retain the exact source, run attempts, job identities, manifests, image indexes, asset hashes, retry equality and negative refusal. R001 and all real first-stable prerequisites remain open. This exercise creates no production stable eligibility or real compatibility verdict.

## Remaining Work

The production before/after comparison is equal: six Releases, eight Git tags and 75 image identities, including every observed source revision and Latest. No production publication identity changed during the exercise. Acquire the L-OPS landing window, update onto current main and recheck publication-input equality. Run the required final gates, obtain independent exact-head review, dispatch full CI and land through the guarded lane helper. Watch the main-push gate after landing. Final frozen-head identities and gate observations belong to the protected checkpoint rather than a prediction in this commit.
