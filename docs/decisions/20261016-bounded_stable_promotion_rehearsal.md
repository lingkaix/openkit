---
status: Accepted
date: "2026-10-16"
decider: Coordinator, under Engineer experimental-use authorization
---
# Bounded Synthetic Stable Promotion Rehearsal

## Decision

The coordinator supplied the engineer's 2026-10-16 direction that the notrucked organization is the organization for experiments and tests, then granted the requested P15 exception:

> On that basis I grant your "smallest requested exception" exactly as you wrote it: a bounded synthetic stable-promotion rehearsal only in notrucked/openkit and its own packages (one unused synthetic stable tag on its already-published synthetic prerelease commit, its scratch GitHub Release and the scratch-only Latest changes, an immutable same-tag retry and a negative retry check), with rehearsal-only fixture admission while R001 and the real first-stable prerequisites stay open. No stable release or Latest change in lingkaix/openkit, no change to the production preflight default, no new scratch owner, visibility or credential change.

[Release Management](../specs/20260829-release_management.md#bounded-synthetic-stable-rehearsal) owns the exception. The existing standing scratch grant remains prerelease-only. The implemented stable path admits only the synthetic scratch version family and refuses production. Stable promotion retains the original prerelease attachment names, checksums, manifest provenance, archive bytes and image indexes at the same source commit; its title and stable image tags record the promotion. A synthetic assertion or passing rehearsal is not product compatibility, story coverage, Worker qualification or stable eligibility.

## Reason

P15 must prove manifest delivery and stable promotion without rebuilding before the first production stable release. The existing grant explicitly excludes stable publication and Latest mutation, so the operator stopped before those effects. The bounded experimental exception permits the actual path and immutable retry to be tested while the real first-stable gates remain hard. Keeping the original attachment names avoids altering archive provenance or rebuilding bytes to put a stable tag inside them.

## Rejected Alternatives

Silently treating the prerelease grant as stable authority would exceed its accepted scope. Removing R001 or the production prerelease-only guard would convert a synthetic test into product eligibility. Repacking archives or retagging a different image index would defeat the accepted no-rebuild requirement. A local fixture alone cannot prove the GitHub and registry effect domains.

## Revisit When

Revisit if the bounded rehearsal needs another stable identity, another repository, a visibility or credential change, or any production stable effect. Missing, partial, conflicting or unknown results require inspection before retry. Production stable admission requires its own engineer gate after the accepted first-stable prerequisites close.

## Affected Owners

- [Release Management](../specs/20260829-release_management.md).
- [Release Cookbook](../cookbooks/release.md).
