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

Focused producer, preflight, promotion, workflow and offline admission suites initially passed 272 tests with zero failures or skips. The earlier frozen-job run observed exactly the two intended publication-pin failures before those pins changed. The full repository gate, independent exact-head review, scratch publication, stable promotion, same-tag retry, negative check and production before/after equality remain pending until their actual evidence is retained. Do not infer acceptance from this implementation report.

The protected lane checkpoint and raw receipts remain outside the repository in the coordinator's evidence store. Later frozen commit identities and gate results are recorded there; this record does not predict them.

## Remaining Work

Run the accepted scratch path and inspect its actual source/job/input and index/archive identities. Retain failures rather than moving tags or overwriting artifacts. Acquire the L-OPS landing window only when implementation is ready, update onto current main, run the required gates, obtain independent review, dispatch exact-head full CI and land through the guarded lane helper. Watch the main-push gate after landing.
