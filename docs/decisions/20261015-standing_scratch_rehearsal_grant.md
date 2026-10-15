---
status: Accepted
date: "2026-10-15"
decider: Engineer
---
# Standing Prerelease Scratch Rehearsal Grant

## Decision

The engineer selected the following option on 2026-10-15, verbatim:

> Standing scratch grant (Recommended) — Authorize scratch rehearsals in notrucked/openkit for any prerelease whose publication path changed, now and for later prereleases. A rehearsal writes only to notrucked/openkit (scratch tag, prerelease, package versions). If it passes, rc.6 is tagged under the standing grant. This also removes this question from future releases.

[Release Management](../specs/20260829-release_management.md#publication-path-proof) owns this bounded grant. It replaces per-rehearsal authorization only for prerelease publication-path rehearsals in the existing `notrucked/openkit` repository. Writes are limited to that repository's scratch preparation commits, unused scratch tags, prereleases and package versions required by the existing publication workflow. It grants no write to `lingkaix/openkit`, no new scratch owner or repository, no stable publication, no Latest mutation, no visibility change and no credential expansion. A passing rehearsal supplies publication-path proof; exact-P review, candidate CI, blocker reconciliation and all other standing prerelease conditions remain required before the real tag.

Source: the engineer ruling supplied to the release preparer on 2026-10-15, recorded in change record 202610131730000000-v0_1_0_rc_6_prerelease.

## Reason

The rc.6 publication job blocks match the successful rc.5 tag run, but the operations packager now includes and verifies the reviewed App-update helper. Its invoked input closure changed. The engineer permits the required scratch proof now and on later prereleases without another routine authorization question.

## Rejected Alternatives

Per-rehearsal authorization retains the routine question that the engineer chose to remove. An unrestricted scratch grant exceeds the selected repository and prerelease scope.

## Revisit When

Revisit if the engineer revokes the grant, the scratch repository is unavailable, the required effect exceeds its bound, or stable publication is proposed. Unknown or conflicting outcomes require inspection, not a wider target or blind retry.

## Affected Owners

- [Release Management](../specs/20260829-release_management.md#publication-path-proof).
- [Release Cookbook](../cookbooks/release.md#publication-path-proof-before-tagging), an operational projection.
