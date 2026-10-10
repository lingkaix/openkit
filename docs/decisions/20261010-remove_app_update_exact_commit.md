---
status: Accepted
date: "2026-10-10"
decider: Engineer
---
# Remove The App Update Helper's Exact-Commit Mode

## Decision

Remove the App update helper's exact-commit source-build mode in rc.1. The product update path is release-only: pull the published App image by immutable digest, with a free-space check before the pull that refuses insufficient space with a specific error code. Remove the `kind` source discriminator and configuration keys that serve only the removed build mode; readers ignore unknown keys as open extension. [App Update Delivery](../specs/20260910-app_update_delivery.md) owns that contract. Counted release rounds deploy the exact candidate source commit through the maintained [external-operator exact-source procedure](../cookbooks/persistent-live-acceptance.md#update-an-exact-source-build), as reflected by [Release Management](../specs/20260829-release_management.md), the [Release Cookbook](../cookbooks/release.md) and [Persistent Deployment Acceptance](../specs/20260909-persistent_deployment_acceptance.md). An authorized external Agent may still deploy any selected commit through the operations Skill and that cookbook procedure.

## Reason

The engineer questioned the product need for source builds on the deployment host on 2026-10-10, quoted verbatim:

> 如果我们把那个从 commit 源码构建镜像这一部分去掉，这个主要考虑到第一个版本上线之后，我们不太会用到这个功能。如果实在需要的话，应该由外部的 agent。 使用 operation skill 这种渠道来进行系统更新，所以如果我们去掉的话，这些问题会解决吗？

Faithful English translation: "If we remove the part that builds an image from a source commit, the main consideration is that after the first version goes live, we will not use this feature much. If it is really needed, an external agent should update the system through a channel such as the operations Skill. If we remove it, will these problems be resolved?"

The engineer then chose removal now and accepted the disk-space refusal, quoted verbatim:

> 好，我们决定去掉它。直接选A，这次就删。同意你在 release 更新拉取镜像前检查磁盘空间（不够就用明确的错误码拒绝）的方案。

Faithful English translation: "All right, we have decided to remove it. Choose A directly and delete it this time. I agree with your proposal to check disk space before pulling the image for a release update and refuse with an explicit error code if there is not enough."

The engineer confirmed the release-flow interpretation and field removal, quoted verbatim:

> 1&2: 关于发布流程的问题，你理解的没有错。3: kind 字段 以及那些只服务于构建的字段 按照你的建议 如果确认不需要了的话，去掉。并且按照我们一贯的做法，对于未知的键保持 开放扩展式的兼容（也就是 读取的时候忽略掉）。

Faithful English translation: "1 and 2: your understanding of the release-flow questions is correct. 3: following your recommendation, remove the kind field and the fields that serve only building if they are confirmed to be unnecessary. And follow our usual approach of open extension compatibility for unknown keys, meaning ignore them when reading."

The accepted analysis starts with the administrator's need: move a deployment to a verified known version and recover on failure. A release pipeline builds that version, CI and smoke checks test it, an immutable digest identifies it, and its tag and commit provide traceability. An image built from a commit on the production host is unverified by definition. Ordinary administrators, users waiting for a fix, fork users and supply-chain-sensitive organizations are better served by a release, a patch prerelease, or their own CI and registry.

The remaining need is OpenKit's own prerelease testing, served by an authorized external-operator procedure rather than a product feature. Keeping the helper build mode requires a host toolchain and several GiB of storage and widens the root helper's duties. All three helper defects found in rc.1 testing were in that path: the round-2 counted-round blocker fixed in `47fd8e9d`, issue #185 and issue #187. Removing it addresses that shared source of complexity while preserving exact-source deployment for operators.

## Rejected Alternatives

- B: keep the commit mode in rc.1 and remove it after release, disclosing #185 and #187 instead. Although it would make the smallest immediate change, it retains an unnecessary host-build path and its defects; the engineer chose A, removal in this candidate.

## Revisit When

No revisit trigger was given by the engineer.

## Affected Owners

- [App Update Delivery](../specs/20260910-app_update_delivery.md): release-only helper, pre-pull free-space refusal, source discriminator and build-only configuration removal, and unknown-key tolerance.
- [Release Management](../specs/20260829-release_management.md): counted-round exact-source deployment path.
- [Release Cookbook](../cookbooks/release.md): each round's installation or update procedure.
- [Persistent Deployment Acceptance](../specs/20260909-persistent_deployment_acceptance.md): current exact-source procedure and retained historical update attribution.
