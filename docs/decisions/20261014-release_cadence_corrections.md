---
status: Accepted
date: "2026-10-14"
decider: Engineer
---
# Release Cadence Priorities And Story 1 Deployment

## Decision

The coordinator relayed two engineer corrections and the deployment facts on 2026-10-14. The dispatch states:

> Two corrections from the engineer (2026-10-14): #193 is closed as superseded by the post-tag policy (record it as closed, not deferred); #240 joins #225 as required before the first stable release.

Issue #193 is closed as superseded by the post-tag policy. Issues #240 and #225 are required before the first stable release. They remain outside the frequent-prerelease implementation path. This corrects item 7 of [the earlier cadence record](20261014-release_cadence.md); the other accepted cadence decisions remain binding.

The same dispatch states:

> Engineer facts for your owner text: `a2` was the earlier persistent test deployment and is now the stable production server; `a1` is the staging server; catalog story 1 will run on this development machine from public repository and release assets without a source checkout in use and without a disposable VM, and that installation stays as this machine's OpenKit deployment.

The dedicated development machine hosts story 1's installation, using the public repository and release assets with no source checkout in use or disposable VM. The installation stays as that machine's OpenKit deployment. Independent Actor and Judge rules remain binding. Automation targets explicitly selected staging/test infrastructure and excludes production `a2`.

The coordinator also authorizes the existing reuse helper and tests to admit main-push evidence beside workflow-dispatch evidence. Reuse remains per job, from the same workflow, and on the exact tagged commit. Other branches, tag pushes, and other events provide no main-push evidence. The full successful candidate gate remains separate from one job's reuse proof.

## Reason

The updated issue dispositions preserve the engineer's stable-release boundary without retaining a superseded candidate channel as pending work. The deployment facts distinguish historical test evidence from present production authority. Retaining the development-machine installation supplies the intended local OpenKit deployment and removes the disposable-VM assumption from story 1.

Main-push reuse prevents repeating L0-L3 after the accepted main-push release gate. Successful job evidence remains independent of unrelated job outcomes; it does not establish a full successful candidate gate by itself.

## Rejected Alternatives

- Leave #193 deferred. The engineer confirms it is closed under the post-tag policy.
- Keep #240 optional for stable promotion. The engineer makes it required before the first stable release.
- Continue treating `a2` as test infrastructure. Its current role is stable production, excluded from automation.
- Use or destroy a disposable VM for story 1. The engineer selects this development machine and retains its deployment.
- Reuse an ordinary branch, tag, different workflow, or different commit. Those runs do not supply the admitted main-push evidence.

## Revisit When

Revisit when the engineer changes deployment roles, selects a different installation scope, changes stable prerequisites, or amends the admitted CI run kinds. Missing evidence and uncertain effects retain their existing fail-closed semantics.

## Affected Owners

- [Release Management](../specs/20260829-release_management.md) owns issue priorities, release deployment scope, and admitted candidate/reuse run kinds.
- [Test Strategy](../specs/20260529-test_strategy.md) projects the candidate and tag gates.
- [L6 Story Acceptance](../specs/20260529-l6_story_acceptance.md) aligns story 1's deployment projection while retaining Actor/Judge independence.
- [Persistent Deployment Acceptance](../specs/20260909-persistent_deployment_acceptance.md) projects current deployment roles and retained installation scope.
