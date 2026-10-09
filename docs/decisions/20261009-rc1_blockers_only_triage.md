---
status: Accepted
date: "2026-10-09"
decider: Engineer
---
# rc.1 Blockers-Only Triage

## Decision

For the `v0.1.0-rc.1` pre-release, fix only newly found defects in these four blocker classes before release: work that gets stuck; data loss or corruption; security or authorization problems; a wrong terminal state or a false success. For every non-blocker, open a GitHub issue and disclose it in the release notes; do not add an extra counted round for it. The rc.1 change record plan records this release-specific triage rule.

Counted-round scenario pass or fail remains judged by the accepted [Release Cookbook](../cookbooks/release.md) and [Persistent Live Acceptance](../cookbooks/persistent-live-acceptance.md). This ruling only decides which newly found defects must be fixed before rc.1 and whether a non-blocking defect forces an additional round. It does not lower any accepted gate, any CI requirement, or the stable-release block, and it does not authorize any effect.

## Reason

The engineer's 2026-10-09 answer to `rc1_triage`, quoted verbatim:

> 只修阻断项：工作卡住、数据丢失或损坏、安全或授权问题、错误的终态或错误的成功；其余开 issue、写入发布说明披露，不为它们增加轮次（推荐）

Faithful English translation: "Fix only blockers: work that gets stuck, data loss or corruption, security or authorization problems, a wrong terminal state or a false success. For everything else, open an issue and disclose it in the release notes; do not add rounds for them (recommended)."

The engineer chose blockers-only so that non-blocking findings do not delay the pre-release indefinitely.

Source: change record 202610071100000000-v0_1_0_rc_1_prerelease.

## Rejected Alternatives

- Fix every defect found during counted rounds before rc.1, with an extra round each time: non-blocking findings could delay the pre-release indefinitely.

## Revisit When

The stable `v0.1.0` release is prepared, or a non-blocking item is shown to cause one of the four blocker classes.

## Affected Owners

- The rc.1 change record plan, change record 202610071100000000-v0_1_0_rc_1_prerelease: records the rc.1 triage ruling and the filed backlog that release notes must disclose.
- [Release Cookbook](../cookbooks/release.md): remains the owner of round judgment, together with its accepted release contract and linked [Persistent Live Acceptance](../cookbooks/persistent-live-acceptance.md) procedure; it is linked but not edited by this change.
