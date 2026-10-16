---
status: Accepted
implementation: Partial
kind: process
date: 2026-08-29
updated: "2026-10-16"
---
# Release Management

## Owns

- The product-wide release identity and release-channel policy.
- The exact composition of an OpenKit release across independently owned artifacts.
- The authorization boundary between local preparation and external publication.
- The release lifecycle from preparation through publication, retry, verification, failure, and supersession.
- The cross-asset consistency and post-publication predicates that make one release complete.
- Pre-stable deployment reset disclosure and the protected-account invariant for the three engineer-named deployments.

## Does Not Own

- Container image contents, image taxonomy, OCI labels, or GHCR naming, which are owned by `docs/specs/20260708-container_image_packaging.md`.
- Skill package contents and host contracts, owned by `docs/specs/20260910-agent_operator_skill.md`.
- NanoHost runtime or distribution readiness, which is owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`.
- Deployment host support profiles, installed dependencies, resource recommendations, and host-requirement verdicts, which are owned by `docs/specs/20260909-deployment_host_requirements.md`.
- Test-layer semantics, which are owned by `docs/specs/20260529-test_strategy.md`.
- Repository visibility, GHCR package visibility mutations, GitHub repository rules, or who receives publication credentials.
- npm publication, desktop packaging, a public Skill registry, component update delivery. This specification owns only release-step composition across those separate effect domains.

## Core References

- `docs/core/foundation.md`
- `docs/core/architecture.md`
- `docs/core/contract-evolution.md`

## Related Docs

- `docs/specs/20260529-test_strategy.md`
- `docs/specs/20260708-container_image_packaging.md`
- `docs/specs/20260910-agent_operator_skill.md`
- `docs/specs/20260721-worker_execution_environment_images.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260909-deployment_host_requirements.md`
- `docs/specs/20260909-persistent_deployment_acceptance.md`
- `docs/specs/20260529-l6_story_acceptance.md`

## Summary

OpenKit releases are explicit, tag-triggered product bundles rather than package-manager releases.

One lowercase semantic-version Git tag identifies the source commit, container images, operations Skill archive, supported NanoHost distribution, checksum, GitHub Release, and verification record.

An authorized agent prepares and verifies the release locally, checks the applicable bounded publication grant or exact-tag authorization, pushes the immutable tag, observes the workflow, resolves any first-publication visibility gate without changing artifact identity, and closes only after post-publication verification succeeds.

## Goals / Non-goals

### Goals

- Give an agent one authoritative answer for what a release is and when it is complete.
- Keep every released byte traceable to one tag and source commit.
- Make a same-tag workflow rerun reuse completed artifacts rather than overwrite them.
- Publish the complete operations Skill beside the release images.
- Publish the NanoHost owner's supported distribution beside the Skill and release images.
- Keep release failure and partial publication visible and recoverable without moving or deleting tags.

### Non-goals

- Do not publish private workspace packages to npm.
- Do not publish `test-env` or the internal dogfood image as product artifacts.
- Do not add signing, mandatory SBOM generation, vulnerability blocking, or GitHub artifact attestations before their existing deferred decisions are activated.
- Do not publish a NanoHost target, installer behavior, or artifact content that its owner has not admitted.
- Do not add a release service, promotion database, custom registry, or compatibility channel.

## Decision

### Release Identity And Channels

The Git tag is the sole OpenKit product release identity.

Tags MUST be lowercase and match `v<major>.<minor>.<patch>` for a stable release or `v<major>.<minor>.<patch>-<pre>` for a prerelease.

Private root, app, and workspace package versions are build metadata only; they are not release identity, are not published, and MUST NOT be mass-updated or validated against the product tag.

The first formal release path is `v0.1.0-rc.1` and later release candidates followed by `v0.1.0` only after the stable-release blocker below is closed.

A tag that builds release artifacts MUST point to a commit that has not been used by an earlier release tag, because its source-revision image tag is an immutable member of that release identity. A same-tag rerun MUST retain the original commit. A stable promotion tag builds nothing. It points at the commit of the prerelease it promotes. It keeps that commit's source attribution.

A prerelease publishes exact-version and source-revision image tags and creates a GitHub prerelease, but MUST NOT create or change either the GHCR `latest` tag or GitHub's Latest release pointer.

A stable release promotes a prerelease of a release cycle in which every catalog story passed, publishes that prerelease's immutable identities, and updates `latest` only after those bytes have passed their release smoke checks. The promoted prerelease itself passed story 2 and Worker qualification. The promotion uses that prerelease's published bytes. It does not rebuild those bytes. Stable publication stays an engineer-reserved gate.

For a stable tag that promotes a reviewed prerelease commit, derive the stable release notes from that prerelease's reviewed notes at the same source commit. Use the stable tag as the release title. Carry forward unresolved items and accepted limitations explicitly; a stable title must not imply that they are closed. This derivation changes neither the promoted source commit nor any packaged asset or image byte. It requires no rebuild or separate notes commit. Retain the exact prerelease notes source and the stable-title transformation in the existing publication evidence. The engineer-reserved stable publication gate remains required. A stable promotion retains the selected prerelease's five attachment names, bytes and checksums, including its source-tagged manifest. The stable GitHub Release title and immutable image version tags identify the promotion; the manifest and archive provenance continue to identify the original prerelease and the same source commit. No renaming, recompression or source reassignment is permitted.

### Release Assets

The current release bundle contains exactly these controlled assets:

| Asset | Distribution | Identity |
| --- | --- | --- |
| Catalog entries with `release: true` | GHCR | Exact version tag, version without `v`, source-revision tag, digest, and stable-only `latest` |
| Operations `openkit-ops` Skill | GitHub Release attachment | `openkit-ops-skill-<tag>.tar.gz` containing the complete `skills/openkit-ops/` tree, repository license, and reviewed `scripts/docker/app-update-helper.py` bytes from the selected release revision |
| NanoHost Distributions | GitHub Release attachments | `openkit-nanohost-<tag>-linux-amd64.tar.gz` and `openkit-nanohost-<tag>-linux-arm64.tar.gz`, each satisfying the exact target, tree, pin, installer, license, and reproducibility contract owned by the NanoHost specification |
| Portable-asset checksum | GitHub Release attachment | `SHA256SUMS` over the three attached archives and the release manifest; the manifest lists archive checksums without a self-checksum |
| Machine-readable release manifest | GitHub Release attachment | `openkit-release-<tag>.json`, bound to the source, image indexes/platforms, portable archive checksums and reviewed compatibility/recovery facts |
| Release record | GitHub Release | Tag, source commit, workflow run, image tags and digests, per-platform manifest digests, the reviewed sections `Changes since the previous candidate` and `Known issues`, automatic gate result, manual-gate disposition, and portable-asset checksum |

The operations archive MUST include the complete operations package with its definition-derived administrator executable, the repository license, and the reviewed App-update helper at `scripts/docker/app-update-helper.py`. Its `SHA256SUMS` entry covers all these bytes. Publication verification MUST refuse a missing or non-regular helper file and require byte equality with the reviewed release checkout; archive presence or checksum equality alone does not establish this source binding. Remote MCP guide and every eligible release-operation dispatch are covered by the retirement regressions; one-time-secret procedures and Web/administrator archive transfers retain their accepted owners. New releases produce no end-user Skill archive or fallback package. Previously published immutable assets are unchanged. [Agent Operator Skill](20260910-agent_operator_skill.md) owns the installed package and [Operation Definition](20261002-operation_definition.md) owns the projection.

The manifest-capable publication path requires five attachments: the three archives, `openkit-release-<tag>.json` and `SHA256SUMS`. The existing `github-release` job generates and uploads the manifest, and `verify-release` reconstructs it from the exact source, image records, reviewed assessment and downloaded archive checksums. Its own checksum is in `SHA256SUMS`; the manifest does not contain a circular self-checksum. Rehearse this publication-path change in scratch together with stable promotion before real publication. Earlier published four-attachment releases remain immutable.

GitHub-generated source archives are convenience snapshots and are not controlled release artifacts or checksum authorities.

All root, app, and workspace package manifests remain private and produce no npm assets.

`test-env` remains an internal CI artifact, and the Codex-plus-Pi dogfood image remains an internal non-release artifact.

The NanoHost owner admits exactly two distribution targets, `linux/amd64` and `linux/arm64`. Release composition MUST use both exact target-matched archives without redefining their contents, destinations, installer semantics, or readiness, and MUST bind each generated manifest to its exact target plus the host-profile id and digest owned by the deployment-host specification. Current packaging implements both admitted targets.

R001 remains open pending fresh exact-product no-host-reboot A1 evidence. Until that runtime gate closes, a release MUST remain a prerelease and its notes MUST state that the NanoHost archive is installable but supported Worker Agent execution is not yet release-ready.

The publishing commit carries `release-notes/<tag>.md` for the tag being published.

That file contains exactly two sections, `Changes since the previous candidate` and `Known issues`, and each section has a non-empty body.

The tag run reads that file and fails before image promotion or GitHub Release creation when the file is missing or malformed.

The published notes include both sections unchanged.

For every published release image, the notes list the index digest and the manifest digest of each catalog platform beside it.

The first stable release requires both an accepted NanoHost distribution artifact and closure of the current R001 runtime gate, or a later accepted product-scope decision to remove Worker Agent execution from that stable release.

### Visibility And Access

`worker-common` MUST satisfy its existing anonymous-public GHCR contract.

Other images and the GitHub Release retain the visibility configured for their owning package or repository; this specification does not silently make them public.

Before publication, the release change record MUST state the observed repository and package visibility and whether the release is private, controlled, or public.

Changing repository or package visibility is a separate explicitly authorized external effect.

### Release Exit Criterion

Before the tag, the deciding check is the deterministic CI that [Test Strategy](20260529-test_strategy.md#ci-and-release-gates) assigns to the candidate and tag gates. The catalog stories are not a pre-tag gate, and a story run on an unpublished candidate is not release evidence. The pre-tag rounds over the former scenario set are removed. [L6 story reorganization](../decisions/20261012-l6_story_reorganization.md) records the reason. This criterion does not replace any other release blocker, and it does not authorize publication by itself.

#### Catalog Stories

A release cycle is every prerelease that shares the version of the prerelease a stable release promotes. Within a release cycle, every catalog story in the [L6 catalog](20260529-l6_story_acceptance.md#catalog) passes at least once. A prerelease need not run every catalog story. Stories 1 and 2 each retain release-cycle coverage. Additionally run the affected story when installation, update behavior, or operator guidance changes. Routine prereleases update the named test deployment mechanically after publication; that update is not an L6 story. For a selected story 2 run, the operator updates from an earlier published release with its real data to the latest published prerelease. The earlier published release is the previous release or an older published release. Before `v0.1.0`, a selected reset follows Pre-Stable Deployment Reset And Protected Accounts below and the documented operator procedure. The stage manager or operator completes that reset as authorized setup before the Story 2 Actor run. Story 2 then verifies the public release disclosure, designated-account sign-in, and successful new work through public product surfaces. It claims neither predecessor-data continuity nor rollback compatibility, and an operator report replaces no helper receipt. The initial development-machine installation uses story 1. The operator chooses which prerelease runs each other catalog story. The catalog stories are not a pre-tag gate, and a story run on an unpublished candidate is not release evidence. Story 1 runs on the dedicated development machine using the public repository and published release assets, without a source checkout in use or a disposable VM. Its installation remains as that machine's OpenKit deployment. [The same-day corrections](../decisions/20261014-release_cadence_corrections.md) record this scope. Story 2 runs on the persistent deployment that carries that earlier release's real data. After the first stable release, the story 2 run that qualifies a stable promotion starts from the previous stable release. Run that persistent deployment on the previous stable release with its real data. When the test server does not already run that release, restore the persistent deployment from a cold backup. [Workspace Backup, Export, Import, And Data-Root Migration](20260704-workspace_backup_export_import.md#backup-and-restore) owns cold backup and restore. Before the first stable release, that story 2 run starts from the previous prerelease. [Story 2 From Any Earlier Release](../decisions/20261013-story_2_from_any_earlier_release.md) records why story 2 starts from an earlier published release. [Catalog story cadence](../decisions/20261012-catalog_story_cadence.md) records the reason. Story 2 replaces the exact-source image build and the container replacement over the existing Data Root. That deploy part leaves the release flow. A persistent deployment updates only to a published release. No supported exact-source update procedure exists. [Retire The Exact-Source Update Procedure](../decisions/20261013-retire_exact_source_update.md) records the reason. [App Update Delivery](20260910-app_update_delivery.md) owns the helper's release-only contract. [App update removal](../decisions/20261010-remove_app_update_exact_commit.md) records the reason.

A catalog story passes on a prerelease when a run on that prerelease passes. Within a release cycle, a catalog story's latest product verdict decides whether that story has passed for the cycle. A later run that confirms a product defect, including a known defect, cancels an earlier pass of that story in the same release cycle until a later prerelease passes it again. A run that confirms a product defect, including a known defect, means the prerelease did not pass, and the fix goes into the next prerelease. A run classified as environment failure, tool failure, inconclusive, or accepted external behaviour proves nothing about the product. That run cancels nothing. The operator may run the story again on the same prerelease, and every run is retained. A story that has not met the [L6 run-consistency rule](20260529-l6_story_acceptance.md#run-consistency) supplies no stable-promotion evidence. Runs on the same prerelease count toward that rule. This section does not restate that rule's counts.

A failing prerelease is fixed in the next prerelease. A stable release promotes a prerelease of a release cycle in which every catalog story passed, when that prerelease itself passed story 2 and Worker qualification, using that prerelease's published bytes and without a rebuild. Stable publication stays an engineer-reserved gate. Real-provider and real-worker execution stays outside automatic tag CI. The separate bounded test-deployment grant below covers its qualification workload. Publication authorization still follows Publication Authorization below.

The stage manager never retries, repairs, or approves on the actor's behalf. An approval in a story is the actor's user action through a public surface. The stage manager keeps thin shared support: parameters, the evidence directory, browser preflight, actor provisioning, evidence collection, and cleanup. [Persistent Deployment Acceptance](20260909-persistent_deployment_acceptance.md) owns attribution and evidence collection. [L6 Story Acceptance](20260529-l6_story_acceptance.md) owns adjudication.

#### Worker Qualification

The four-runtime A to D matrix is Worker qualification on the deployment updated to that published prerelease through the bounded deployment procedure. A qualification pass counts only for the prerelease on which it ran. It is not a story and not a pre-tag round. One runtime does not pass for another. A qualification case passes on a prerelease when a run on that prerelease passes. A run that confirms a product defect, including a known defect, means the prerelease did not pass, and the fix goes into the next prerelease. A run classified as environment failure, tool failure, inconclusive, or accepted external behaviour proves nothing about the product. The operator may run the case again on the same prerelease, and every run is retained. The release record retains this evidence before stable promotion. The [Release Cookbook](../cookbooks/release.md#worker-qualification) carries the matrix. Run all sixteen cases after each deployment update. Run the four runtime groups concurrently within the runtime owner's admitted capacity, with A to D sequential in each group's fresh Thread. Capacity refusal, Provider throttling, and unknown effects remain non-pass observations; never retry a mutation blindly. Worker-only qualification requires no browser launch because no case uses a browser deciding observation. Case A requests one attempt-specific public synthetic sentence without quotation marks, and requires its exact same-Turn completed reply, terminal success, and complete Item coverage. Wrong, stale, empty, and refusal replies remain non-pass. Cases C and D retain exact Artifact-byte, digest, and lineage predicates.

This specification owns the readiness rule. Product records remain authoritative for product results. The release record is evidence, not a new product entity, durable lifecycle, execution service, or automatic repair mechanism. Operators may vary attempt-owned names and equivalent fixtures without changing coverage or outcome criteria. Only the engineer may change catalog membership, and [L6 Story Acceptance](20260529-l6_story_acceptance.md#catalog) owns that list.

#### Classification

Classify an adverse observation as a new product defect, a known defect, accepted external behaviour, an environment or tool failure, or inconclusive. A new product defect is a violation of an OpenKit-owned contract not recorded before the run began, including a new regression or a distinct failure of a known area. A known defect is linked to a record that predates the run, and recording a defect during the run does not make it known for that run. An environment or tool failure is an external prerequisite or instrument that failed independently of the product and prevents judgment. Inconclusive means required execution or deciding evidence is missing, conflicting, partial, or cannot establish whether an effect occurred. Classification never rewrites a product result or an L6 verdict. A known defect is not a successful workflow and does not waive another owner's required pass, an unresolved release blocker, or a reserved engineer decision. Unknown causation cannot be called accepted external behaviour in order to pass a story or a qualification case. Accepted external behaviour stays under the [accepted external-behaviour decision](../decisions/20261002-external_provider_behavior_accepted.md). OpenKit service stability, data correctness, and product logic remain fully owned.

Retain failed and incomplete evidence. A later run does not erase the earlier outcome. Complete retained observations may be re-adjudicated after an evidence-tool correction under Persistent Deployment Acceptance. Missing observations cannot be reconstructed into a pass. Missing, stale, or conflicting evidence leaves the result unproved. Model memory and a producer summary are insufficient. Record the exact deployed artifact identities for the components exercised. A version label alone is insufficient. Relevant configuration changes or operator repairs end the evidence attribution window under Persistent Deployment Acceptance.

The prerelease candidate workflow builds the published image bytes once, and the tag workflow promotes those exact digests. Exact-digest smoke and asset verification still verify those bytes. Those bytes are not claimed to be identical to any earlier unpublished deployment.

### Compact Release Record

Retain one release-level header with the tag, the asset set, publication authorization, the published prerelease identity, candidate CI proof, visibility, and known-defect dispositions. Retain one row per catalog story and one row per Worker-qualification case. Each row names the subject, the published identity, the deployment digests and the time window, the verdict, the classification, and the private evidence alias and digest. In a stable release record, each row for a catalog story names the prerelease on which that story passed. That published identity may be an earlier prerelease of the release cycle.

Outcome codes are P (pass), K (known defect), E (accepted external), N (new defect), T (environment or tool failure), and I (inconclusive). The maintained kit generates verdicts from retained product records. An independent check is required for a non-pass row and for a row the collector cannot decide. An L6 judge remains required for a catalog story. Do not add per-pass narrative review. Complete evidence stays private under Persistent Deployment Acceptance, including attribution, deciding records, and diagnostic coverage. The public record contains no host name, private path, Thread identifier, or transcript. The compact projection never replaces that evidence and never creates a product record owner.

Generate the header and per-case rows from existing image records, qualification summaries, and reviewed authored intent through `scripts/release-record.mjs`, which reuses the existing notes producer. Retain stage start/end timestamps. Generate draft changes from accepted work and carry forward known issues for meaning review; commit the reviewed two-section input before freezing P. Do not rewrite completed evidence into P.

### Candidate CI And Tag Reuse

The candidate gate is a completed successful main-push release-gate run or `workflow_dispatch` run selecting `release-gate` or `full` on exactly publishing commit P. If P differs from tested commit T, it needs its own candidate gate; CI reuse never crosses commits.

Candidate admission requires one unambiguous successful job observation for every required gate job, including all four Worker-image platform smoke cases; missing, skipped, failed or duplicate job observations refuse.

The L0-L2 aggregate requires every shard in the checkout-derived owner inventory. Each deterministic Vitest package runs its complete admitted coverage command in one shard, with unchanged selection and thresholds. Static checks and builds, native and catalog tests, root tests, generated CLI equality, and Python App-update regressions remain required distinct executions. Compare the actual coverage execution's file inventory with Vitest's collected file inventory: every selected file executes exactly once. Missing, duplicate, failed, cancelled or skipped shards refuse the aggregate. Cache dependencies and build outputs, never a test verdict.

An exact-head pre-merge check dispatches the complete release gate before an ordinary fast-forward of main to that same commit. A moved branch, unsuccessful or incomplete run, or non-fast-forward update refuses the merge. Squash and rebase change P and require a new gate. The helper does not enforce other writers or change repository protection. Main still starts its deterministic release workflow; its complete-suite shards may reuse exact-SHA successful latest-attempt dispatch observations, retaining the actual run, attempt and job links. Main reuse never substitutes for complete candidate admission.

In a tag run, each complete L0-L2 shard and `L3 NanoCore e2e` first looks for a completed main-push release-gate run or qualifying `workflow_dispatch` run of the same workflow on exactly the tagged commit in which that same job succeeded in its latest attempt. When found, the tag job records the supporting run and skips its tests; otherwise it runs its tests as before. Reuse admits only `workflow_dispatch` runs or `push` runs whose branch is `main`, from the same workflow and exact tagged commit. Tag pushes, other branches, pull requests, and other events supply no reuse evidence. Reuse is decided separately for each job and establishes no other job's result. An unrelated job failure does not invalidate the selected successful job; the full successful candidate gate remains a separate pre-tag requirement.

On a prerelease tag, every other required tag job still runs: preflight and `main` membership, L5 smoke, portability, the installer gate, NanoHost builds and qualification, packaging, promotion, anonymous `worker-common` inspection, GitHub Release creation and upload, and published-release download verification. Image construction and per-platform exact-digest smoke run once in candidate CI under the candidate-image rule below; their proved digests replace tag-stage rebuilding. A stable promotion runs promotion of the already-published digests, the release pointers, GitHub Release creation, and published-release verification.

### Prerelease Candidate Images

Candidate images are projections of one exact source commit, intended prerelease tag and observed CI attempt; they are not a release registry, published release or deployment input. Select the intended tag from a committed unused two-section notes input before freezing P. An explicit dispatch may select one such input. With no pending input, ordinary main validation runs without candidate image publication. Before selecting P, generate and review notes; editing notes after selection creates a new P.

Build each catalog platform natively once, push its digest, smoke the registry digest, and record matching OCI source/revision/version and App identity. Worker candidate jobs retain the existing four platform smoke observation names and replace the ordinary diagnostic builds in that run. Assemble exactly those manifests into an index under a candidate-only reference. The record binds the repository, tag, P, run, latest attempt, publication-input fingerprint, complete platform set, index/platform digests, metadata and successful exact-P smoke. A completed successful exact-P candidate run must include every image's successful index job in addition to all prior candidate gates.

The tag job accepts an artifact only from the same repository and workflow, a successful completed exact-P run and its still-current attempt. It validates every binding, checks the registry index contains exactly the recorded platform digests, and promotes the recorded index unchanged. The build/smoke record proves metadata and App bytes through that immutable digest. A changed P invalidates earlier evidence even if its tree is unchanged. Missing, expired, partial, failed or contradictory evidence refuses promotion and requires inspection or a new candidate run; there is no tag-stage rebuild fallback. Fourteen-day CI artifact retention is availability, not a freshness waiver. An uncertain registry operation is inspected before any retry.

No exact-version, version-without-v, source-revision, GHCR Latest or GitHub Latest identity moves before the authorized tag push. Pre-tag admission still proves unused release identities or the admitted exact immutable retry. Tag preflight, main membership, NanoHost qualification, portable packaging, immutable reuse, Latest invariants, anonymous pull and published downloads remain required. Stable rules and blockers are unchanged. Publication proof covers candidate construction, smoke, index assembly and their script, catalog, Dockerfile and smoke-input closure as well as the tag publication jobs. The existing scratch grant rehearses that entire changed path before real publication.

Local pre-tag admission MUST NOT need registry-read credentials. After the required candidate dependencies succeed, the workflow's read-only package job reuses their exact index and platform records, verifies the registry indexes and immutable release identities, and retains a non-secret observation artifact. It binds repository, P, intended tag, publication inputs, the original candidate run/attempt, the inspection run/attempt, and the actual inspection interval. Local admission selects the unique non-expired attempt-qualified artifact through the exact run API, retains its immutable artifact ID and record checksum, validates all bindings and complete images, and rechecks the current run attempt after download and before the tag effect. Missing, duplicate, expired, mismatched or failed evidence refuses. The inspection interval must remain inside the reviewed admission validity window; downloading it again never refreshes its time. Artifact retention grants no freshness.

An explicit `registry-admission` dispatch can refresh only these observations at the same exact P using an identified successful current candidate run. It builds and promotes nothing. This supports a fresh observation window and explicitly permitted partial-publication retries without rebuilding candidate images. Every existing image's complete immutable tag set must match its proved candidate digest; whole images may remain absent, while partial or conflicting tag sets and unknown registry results refuse. The original complete candidate gate stays required. Tag publication still performs its live immutable-state and digest checks. No private image bytes or registry credentials enter the observation artifact.

### Publication-Path Proof

An image publication and promotion job, GitHub Release creation and upload job, or published-release verification job is proved when an earlier real tag run executed it successfully and that job and its implementation inputs are unchanged since then. Retain the earlier tag/run, successful job evidence, and comparison establishing the unchanged job. Skipped publication jobs or non-publishing probes do not establish this proof.

A changed publication job MUST be rehearsed before the real tag in a scratch repository under a different GitHub owner. The rehearsal executes the real changed publication path while leaving the real package names, tags, and Latest pointers untouched. For prereleases, the engineer grants standing authorization for the required rehearsals only in the existing `notrucked/openkit` repository, including scratch preparation commits, unused scratch tags, prereleases and package versions needed by the publication workflow. This grant creates no new scratch owner or repository and authorizes no write to `lingkaix/openkit`, stable publication, Latest mutation, visibility change or credential expansion. Effects outside that bound remain engineer-reserved. [Standing Scratch Rehearsal Grant](../decisions/20261015-standing_scratch_rehearsal_grant.md) records the 2026-10-15 ruling. Missing or conflicting proof blocks the real tag until qualifying evidence exists; no routine different-owner rehearsal is required for an unchanged proved job. [L6 story reorganization](../decisions/20261012-l6_story_reorganization.md) records the decision and exclusions.

### Bounded Synthetic Stable Rehearsal

The coordinator grants one synthetic stable-promotion rehearsal only in the existing `notrucked/openkit` repository and its own packages, under the engineer's 2026-10-16 experimental-use authorization. It covers one unused synthetic stable tag on its already-published synthetic prerelease commit, its scratch GitHub Release and scratch-only Latest changes, an immutable same-tag retry and a negative retry check. Rehearsal-only fixture admission is permitted while R001 and real first-stable prerequisites remain open. The [bounded rehearsal decision](../decisions/20261016-bounded_stable_promotion_rehearsal.md) records the exact scope.

The tag-only `release-promotion.yml` path refuses production and non-synthetic stable versions before publication. It verifies the source prerelease's complete latest-attempt successful publication and native App smoke, source tag and commit, reviewed notes, five downloaded attachments, manifest assertions and all exact image/platform identities before assignment. It assigns the already-published indexes without building or packaging, copies the source attachments unchanged, derives the stable title from the reviewed prerelease notes and then repeats published-download and image verification. A complete immutable retry verifies without rewriting images or the Release; partial or conflicting stable identities, a missing or superseded Latest, changed source or unknown state refuse. A negative retry check must not damage live pointers to construct its failure.

This exception grants no stable release or Latest change in `lingkaix/openkit`, no change to the production preflight default, no new scratch owner, visibility change or credential change. The ordinary standing scratch grant remains prerelease-only. Production stable publication remains disabled while R001 is open and remains engineer-reserved after its prerequisites close. A successful synthetic rehearsal supplies no product stable eligibility or real-host qualification.

### Publication Authorization

Local preparation, a green gate, a release branch, or an existing tag name does not authorize publication.

The engineer grants publication of successive `v0.1.0-rc.N` prereleases beginning with `v0.1.0-rc.6` from reviewed commits contained in `main`, using the approved controlled asset set and publication implementation, while all predicates below hold. The grant authorizes no stable release, Latest mutation, visibility change, credential expansion, destructive recovery, or alteration of an existing published identity. The grant is revocable and ends at the release-cycle boundary or a change to its approved conditions. [The release-cadence ruling](../decisions/20261014-release_cadence.md) records acceptance.

Outside the standing grant, publication needs engineer authorization for the exact tag and resulting asset set. Stable publication remains engineer-reserved.

Before tagging, a mechanical check MUST establish all of these predicates from current retained observations:

- The unrevoked grant applies to this repository, version family, tag, and exact asset set.
- Exact publishing commit P is reviewed, contained in `main`, and has successful candidate run and required job evidence.
- The publication jobs and their implementation inputs match an approved successful real-tag baseline. Read immutable Git bytes at exact P and the proved baseline commit: hash each publication job YAML block, every script it invokes, and the current static relative-import/literal-file dependency closure. Retain the per-input Git blob identities and aggregate comparison. Self-consistent snapshot hashes alone establish no proof. Missing objects or changed bytes refuse. A changed path leaves routine authorization until reviewed and rehearsed.
- The tag and immutable image identities are unused, or an explicitly permitted same-tag retry proves the existing immutable-reuse rules.
- The blocker label exists, the backlog was initially reconciled, and current triage coverage is complete. No applicable open prerelease blocker exists; every known non-blocker has a disposition and disclosure.
- Prerelease flags are fixed, GHCR `latest` stays untouched, and GitHub Latest is not assigned.
- Evidence is available, fresh within its declared observation validity, internally consistent, and bound to P and the proposed tag. Exact-commit binding is required; no one-hour freshness cap is specified. A missing condition refuses publication.

Baseline approval and tag grammar are separate predicates. The retained grant MUST name the approved baseline kind, repository, exact tag, source commit, CI workflow path, run ID and attempt. The approval identity is an authority-bearing closed object and MUST refuse unknown fields. Observed baseline identity MUST match that approval. Its tag MUST resolve to the observed run's source commit, its event MUST be a tag push, and every required successful job execution MUST bind to that same run, attempt and source. Baseline tags use the canonical `parseVersionTag` grammar. A changed-path scratch rehearsal under the standing grant MUST use `notrucked/openkit` and a prerelease tag. An approved earlier real tag run in the production repository remains an eligible unchanged-publication baseline. Baseline eligibility does not authorize stable publication or change any other admission predicate. The [release cookbook](../cookbooks/release.md#baseline-evidence-fields) documents the offline input fields and their observation sources.

The `release-blocker` label identifies an open finding that blocks the applicable prerelease under an owning contract or engineer decision. Label absence alone proves nothing. Initially reconcile all open findings before admitting the standing grant, and retain that reconciliation. A known defect is not automatically a non-blocker. Record the owner, applicability, disposition, and disclosure for each finding; strict-risk dispositions stay engineer-reserved. The policy is prospective and does not rewrite earlier release triage.

### Pre-Stable Deployment Reset And Protected Accounts

Before the first stable release, `v0.1.0`, a change MAY reset deployment data instead of migrating it. [Contract Evolution](../core/contract-evolution.md#retained-data-continuity) owns that boundary. [Pre-Stable Data Continuity](../decisions/20261014-pre_stable_data_continuity.md) records the engineer's pre-`v0.1.0` interpretation of root AGENTS.md clauses NONNEG-001 and COMPAT-001. This reset scope follows that interpretation, not an AGENTS.md amendment.

If a release cannot read the previous release's retained data, its release record and operator procedure MUST say so. They MUST name the affected data and state whether the selected transition carries it forward or resets it. The existing published release notes MUST expose the data limitation and disposition through the release's public interface. A reset requires an explicitly authorized operator procedure for the exact deployment and data scope. Ordinary startup MUST NOT reset data. A reset does not expand the standing automated update grant, authorize a production effect, replay unknown work, or bypass predecessor fencing.

On this development machine, `a1` staging, and `a2` production, the accounts the engineer names for each deployment MUST stay registered and usable through every reset and reinstall. The operator MUST keep the account list and credentials outside the repository. The coordinator and the test agent MUST use the account the engineer designates for staging. They use it for testing, acceptance, maintenance, and other staging operations. Repository records MUST contain no personal account identifiers, email addresses, passwords, or credential locations for this list.

A reset procedure MUST preserve the registration and usable access of those accounts. Before returning the deployment to ordinary use, the operator MUST verify each designated account's registration and usability through the existing public surfaces. Evidence records the observed usability without personal account data or secrets. Missing account evidence prevents reset or reinstall completion. This rule creates no account store, default credential, private authentication path, or automatic reset mechanism.

For the P14 identifier cutover only, the engineer accepts a staged clean candidate and same-name re-registration under new canonical User and authentication-account record IDs. Re-register the same engineer-named login identities with operator-held credentials; do not convert predecessor account data or add an old-ID reader. Verify every designated account's registration and fresh login on the candidate before switching. Verify the required administrator operation with its designated administrator account; do not expand another account's authority. Re-issue administrator tokens into operator configuration only. Keep account identifiers, credentials and credential locations outside repository evidence. This is the accepted interpretation of protected-account continuity for this cutover ([engineer ruling](../decisions/20261015-p14_protected_account_reset.md)).

The same ruling grants the OpenKit identifier-reset authorization for this development machine, `a1` staging and `a2` production at once. Do not request that authorization again for the same scope. Execute one explicitly selected deployment at a time under its exact bounded operator procedure and record its separate outcome. On `a1`, navidrome, blinko, memos and Dokploy remain untouched. On `a2`, all non-OpenKit services remain untouched. Preserve unrelated host state on the development machine. The grant waives neither public incompatibility disclosure, exact candidate/data scope, current writer fencing, protected-account verification nor the coordinator's implementation/effect-stage boundary. It grants no future production reset or expansion of ordinary automated updates. Missing or contradictory required evidence stops the selected target before its next dependent effect; unknown effects retain their existing inspection and recovery rules. No reset is executed by this owner amendment.

From `v0.1.0`, retained data MUST follow additive evolution or an accepted one-way migration under Contract Evolution. A pre-stable reset is not a data-continuity pass and does not prove rollback compatibility.

### Bounded Test Deployment Update

Publication, deployment, and qualification results remain separate. After verified publication and successful local tests, automatically update only the explicitly selected staging/test deployment under existing credential custody. The engineer identifies `a1` as staging, dogfooding, and persistent test deployment. `a2` was the earlier persistent test deployment and is now stable production; exclude it from all automation. The local x86_64 machine is dedicated development/test infrastructure. Each update and qualification invocation takes exactly one explicit SSH alias or URL target, with no default; resolve it against the retained authorized deployment binding before any effect.

The separate standing deployment grant permits migration-free, configuration-compatible updates with explicit assessed retained-data continuity and recovery eligibility, an idle maintenance preflight, the existing App prepare/preflight/start/status operations, then accepted NanoHost replacement and Worker environment preparation/activation. It permits sixteen qualification Turns per updated prerelease using the existing four runtime credentials, or thirty-two to forty-eight Turns at two to three releases per day. It expands no credential scope and disposes no retained data. Stop on active work, missing assessment, incompatible configuration, unassessed migration, failed readiness, budget exhaustion, conflicting identity, or unknown effect. No automatic repair, restoration of data, or blind effect retry is admitted. Component owners retain approval, fencing, compatibility, and recovery semantics; a missing admitted operation stops that dependent stage.

Retain the exact App prepared request ID before start; inspect that ID after an uncertain handoff. The App owner retains its protected compatibility assessment; a release assertion cannot manufacture that verdict or an approval. Record App, NanoHost, and Worker outcomes and identities independently. Verify exact published platform/image/distribution identities and public reads of selected pre-existing Workspace records before and after update. Authentication metadata continuity alone does not prove Workspace continuity. NanoHost replacement preserves its own retention and predecessor-fencing obligations; Worker preparation must exercise fresh-epoch acquisition and activation, not infer success from a warm image. An unsuccessful component leaves later dependent stages unproved.

#### Exact Release Management Evidence Criteria For Routing

For a bounded deployment update, each admitted NanoHost observation MUST join one fresh unpredictable nonce-bound operator inspection with server-admin runtime-target observations read immediately before and after that inspection. The operator channel MUST independently authenticate the retained host binding. Both stored observations and the live coordinator MUST identify the same NanoHost identity, deployment, exact connection generation and physical Epoch. Both stored observations MUST be ready, fresh-empty and predecessor-fenced. The public physicalEpoch is a nullable stored witness, not a live host measurement. Missing or cleared evidence cannot establish readiness.

The inspection MUST measure the running NanoHost and current Epoch Gateway executable images through their live process incarnations, the installed unit payload and canonical non-secret effective unit state. It MUST bind the request nonce, boot identity, PID and process start stamp across measurement and MUST refuse a replacement or connection change during measurement. The machineIdentityDigest MUST be SHA-256 of the platform installation-identifier bytes under Deployment Host Requirements; raw identifiers MUST NOT enter update evidence. The effective unit state MUST equal the independently accepted upstream replacement baseline.

The selected retained NanoHost archive MUST pass the existing release verifier against its published outer checksum and release source provenance. Evidence MUST retain archive checksum, release tag, source commit, platform and the verified NanoHost, Gateway and unit payload checksums. Each live payload measurement MUST match the corresponding verified archive payload. The archive checksum establishes supply attribution; it is not a checksum of a running executable and does not approve unit overrides. No installer receipt or product registry is required.

A same-Epoch reconnect changes connection generation and invalidates an earlier join. An explicitly new observation may establish a new join, but a failed or unknown attempt MUST NOT retry or silently refresh its evidence. Wrong nonce, replay, mismatched machine/process/payload/unit/archive/connection/Epoch, process replacement, timeout, malformed response or unavailable evidence MUST stop the dependent effect. Retain separate component outcomes and existing request IDs for inspection; no automatic retry, repair, rollback, reset or live qualification claim follows from fixture success. These observations trust the authenticated operator channel and host OS; they do not provide hardware attestation or protection from malicious host root.

### Machine-readable Release Manifest

The manifest is a projection of existing publication facts, not a release registry or migration graph. Its closed core names schema version, repository, tag, exact source commit, all release image index/platform digests, portable asset names/checksums, and explicit compatibility/recovery assertions with provenance. Readers ignore unknown optional additive fields and fail closed on unknown core semantics. Each assertion binds the actual previous Docker App image ID and candidate source/published App digest. These identity domains are distinct; a manifest digest is not a Docker image ID. It states migration-free status, configuration and retained-data compatibility, and previous-image recovery eligibility. Missing, unknown, contradictory, or unassessed facts stop unattended selection. A general compatible boolean authorizes neither migration nor rollback. Protected host assessment and component-owner observations remain required.

Generate the manifest from existing image JSON and portable checksums at publication. Commit the reviewed facts in `release-notes/<tag>.manifest.json` before freezing the publishing source. This closed input contains the actual `previousAppImageId`, true `migrationFree`, `configurationCompatible` and `retainedDataCompatible`, `recovery: "previous-image-compatible"`, and a neutral reviewed `provenance` alias. The producer joins the exact checkout source and published App digest; the authored input must not supply or override either identity. The tag preflight refuses a missing, negative, unknown or unassessed declaration before image promotion. These facts qualify only their bound transition and never replace host assessment. Fixture facts in the synthetic rehearsal establish no product compatibility. Verify the downloaded manifest against those same published identities. An existing release remains immutable. Failure leaves the release incomplete; retry uses the existing publication rules, and correction of published facts requires a new release.

The authorized tag push is the single workflow trigger for publication; no ordinary branch push, pull request, or local command publishes product assets.

The workflow uses only the job-scoped GitHub permissions required to read source, publish packages, and create the GitHub Release.

### Candidate, Promotion, And Idempotency

For a prerelease, each candidate platform build first pushes only a digest-addressed candidate with no release tag before the tag workflow. Index assembly may assign only its unambiguous candidate-only reference.

For a prerelease, candidate CI MUST smoke every exact platform digest and the tag workflow MUST verify that proof under Prerelease Candidate Images before assigning a release tag.

On a tag that builds release artifacts, promotion assigns all required release tags to the already-smoked digest without rebuilding it.

Published OCI metadata MUST be derived from the source commit and release inputs; it MUST NOT contain a workflow-run clock value that changes the image digest on retry.

Release runs are serialized across tags so two stable releases cannot race on `latest`.

For a prerelease, absence of the exact-version, version-without-`v`, and source-revision tags admits promotion of the proved exact-P candidate. Candidate construction alone admits no release identity.

On a tag that builds release artifacts, presence of all three immutable tags at the same digest admits idempotent reuse and MUST NOT rebuild, retag, or mutate the image.

On a tag that builds release artifacts, presence of only one tag, different digests, or an existing tag whose release identity cannot be proved is a conflict that fails closed.

The GitHub Release is created only after every image promotion and portable asset completes.

An existing published GitHub Release is terminal for that tag; a rerun verifies it and MUST NOT edit its notes or replace its assets.

### Failure, Retry, And Supersession

A build or smoke failure before promotion may leave untagged registry content, but it MUST leave no new release tag for that failed image.

A matrix or network failure after some images are promoted is a partial publication: no GitHub Release is created, already promoted tags remain immutable, and the release change record records the observed digests and failed boundary.

Retry of a partial publication uses the same tag only when every existing immutable tag set proves the expected same digest; it reuses those images and promotes only entirely absent image identities from proved exact-P candidates.

A stable same-tag rerun is admitted only while every `latest` tag still resolves to that stable release's recorded digest; a superseded stable tag or a stable publication that did not complete `latest` fails closed and requires a new stable tag on a new commit rather than moving `latest` backward.

An ambiguous, conflicting, or behaviorally defective promoted artifact is never deleted, overwritten, or repaired under the same version.

The correction is a new prerelease or patch tag, and any incorrect stable `latest` pointer is repaired only by that explicitly authorized successful stable release.

A failed or incomplete GitHub Release creation is not repaired by editing an already published release; the workflow fails for operator inspection and follows GitHub's draft recovery boundary without deleting a published release.

Restarting an authorized workflow changes no authority: the tag and current registry state are re-read before any build or promotion.

### Post-publication Verification

After publication, the workflow MUST verify that every exact-version image tag resolves to the digest recorded for that image.

For every active stable release run, including an admitted same-tag rerun, every `latest` image tag MUST resolve to that same digest.

For a newly promoted prerelease, the workflow MUST prove that it did not change a pre-existing `latest` digest and did not create one when none existed.

The workflow MUST log out of GHCR and inspect the exact `worker-common` digest without credentials.

The workflow MUST download every controlled GitHub Release attachment and verify `SHA256SUMS`. It MUST inspect the complete operations Skill archive, including its executable mode, entrypoint and resolvable packaged references. Run that extracted administrator CLI's local definition-derived operation discovery under Node.js 24 without a NanoCore connection outside the checkout. It MUST run the same executable NanoHost release-asset verifier used before publication against both downloaded NanoHost archives, including exact tree, target and generated-manifest consistency, inner checksums, target-matched ELF identity, and a newly created contained `DESTDIR` installation. Cross-target staging makes no live NanoHost readiness claim; fresh target-matched real-host qualification is separate.

The GitHub Release prerelease state MUST agree with the tag, and its notes MUST name the source commit, workflow run, image digests, automatic gates, manual-gate disposition, visibility posture, NanoHost target and current R001 runtime status, and portable-asset checksum.

## Current Implementation Projection

Issue [#193](https://github.com/lingkaix/openkit/issues/193) is closed as superseded by the post-tag policy. No candidate-channel implementation remains pending. [The corrected priorities](../decisions/20261014-release_cadence_corrections.md) record the ruling.

The operations-only Skill composition, executable preflight, packaging and local verification are implemented. The machine-readable manifest is generated, checksummed and carried through the existing publication and independent download-verification jobs. Missing reviewed compatibility facts stop publication automation; no positive assessment is inferred from a successful build. The tag-only synthetic stable path copies the proved source indexes and five attachments without rebuilding. Production stable admission remains disabled pending its separately reserved prerequisites. The bounded App composition checks preparation summaries and exact helper identities; its live identity adapter, complete component update sequence and first preflight-less upgrade remain unresolved. This local change does not demonstrate release publication or live-client acceptance.

The `.github/workflows/ci.yml` workflow implements the nonpublishing release gate on every main push, tag preflight, L0-L3, L5, a catalog-derived image matrix, GHCR publication, anonymous `worker-common` inspection, and GitHub Release creation. Its complete L0-L2 shard jobs reuse exact-commit evidence on main and tag pushes, and its `nano-core-e2e` tag job uses the same observed-run rules through `scripts/release-ci-reuse.mjs`. The host L0-L2 aggregate requires every shard result. Tag run 38093270321 on `v0.1.0-rc.3` completed successfully. That run reused candidate CI for the L0-L2 and L3 jobs. Prerelease candidate CI builds and smokes native platform digests before the tag, and the tag promotes their proved index without rebuilding. The separate synthetic stable-promotion workflow proves the no-rebuild mechanism under its bounded exception; production stable admission remains reserved and disabled while R001 is open. The runner does not build an image or replace a container. The runner runs the Worker qualification groups.

The current implementation removes package-version coupling, makes tag parsing lowercase-only, pins every release image base, packages the complete operations Skill including the administrator executable, separates digest candidates from tag promotion, serializes releases, preserves same-tag image identity, applies GitHub prerelease semantics, and performs post-publication verification.

Native amd64 and arm64 NanoHost build jobs, target-selected stock Gateway supply, deterministic packaging, one shared portable checksum, target-aware verification, manifest-capable five-attachment composition, and both downloaded-archive checks are implemented. The isolated fixed-path installer gate exercises both ELF machines. The tag-only hosted qualification matrix consumes exact packaged inputs on `ubuntu-24.04` and `ubuntu-24.04-arm`, records image and prerequisite package versions, requires fresh static requirements and no-write installation disposition, proves unchanged live destinations, and performs contained staging before either publication job. Pull-request and workflow-dispatch gates retain their existing scope. This wiring implements the [release-time qualification ruling](../decisions/20261005-first_release_lifecycle_and_verification_scope.md); no hosted run or publication is claimed by local implementation. Historical arm64 R002 evidence belongs to exact candidate `1a5468bce556c14bb3dfc16550a9dc2f1c7adad5` and does not qualify a changed candidate. R004 remains open until a separately authorized complete tag is published and verified, and stable preflight remains blocked while R001 is open.

`gh repo view --json visibility` on 2026-10-12 returned `PUBLIC` for `lingkaix/openkit`. GitHub releases `v0.1.0-rc.2` and `v0.1.0-rc.3` are published prereleases. The tag `v0.1.0-rc.1` exists, and `gh release view v0.1.0-rc.1` returned no GitHub release. This documentation change does not publish a release or change visibility.

## Testing Strategy / Acceptance Criteria

- The release tag parser accepts lowercase stable and prerelease identities and rejects uppercase identities, while the current release preflight CLI rejects stable tags by default and rejects a release image without a digest-pinned base.
- Release preflight requires the operations Skill entrypoint and executable inputs and does not inspect private workspace package versions.
- The app Dockerfile and image catalog declare the same digest-pinned Node base.
- Every third-party GitHub Action reference in the workflow is pinned to an immutable commit.
- The workflow pushes a digest candidate, smokes every declared platform before promotion, and reuses matching version and source-revision tags without mutation.
- A prerelease GitHub Release is marked prerelease and not Latest; a stable release is marked stable.
- The deterministic Skill packager produces an archive with the expected envelope, complete Skill directory, executable bundle, repository license, and matching SHA-256.
- Target-native tag-only amd64 and arm64 jobs read the NanoHost Rust version from its existing app pin, perform locked release builds, run each binary's side-effect-free `--version`, and hand only the target-matched binary to portable packaging without A1 or a cross-build framework.
- The NanoHost packager consumes each specification-owned target and one accepted pin projection, verifies the target-matched Gateway and commit-bound OpenShell license bytes, rejects architecture-mismatched inputs, and produces each exact archive twice with identical bytes.
- One shared target-aware NanoHost release-asset verifier accepts both intact pre-publication and downloaded post-publication archives and rejects checksum corruption, wrong tree or architecture, generated-manifest inconsistency, and staging escape before writes.
- Historical R002 closed for the initial arm64 artifact only after the exact final candidate commit was built natively on A1, reported its version, packaged the real pin-bound inputs, reported successful package and host prerequisites plus the expected nonzero `destination-conflict` for the earlier installed NanoHost bytes, proved all live destinations unchanged, and installed only beneath a newly created contained `DESTDIR`. The amd64 target requires its own target-native implementation and qualification, but does not reopen that historical result or make A1 the exclusive future qualification host.
- The repository release gate passes without requiring Docker for ordinary checks; image publication behavior remains decided only by the tag workflow.
- A completed real release satisfies every post-publication predicate above before its release change record becomes verified.

## Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| First `worker-common` publication creates a private package. | The anonymous exact-digest gate fails, an administrator changes visibility once, and the same-tag rerun reuses the already-smoked digest. |
| A matrix failure leaves a partial release. | Version tags are immutable, GitHub Release creation waits for the full matrix, and retry reuses proved pairs while building only missing images. |
| Two releases race on `latest`. | One workflow-level release concurrency group serializes tag releases. |
| A private repository is mistaken for a public product release. | The release record states observed visibility, and visibility changes require separate authorization. |
| An installable NanoHost archive is mistaken for runtime readiness. | Prerelease notes disclose the open R001 runtime gate, stable preflight remains blocked, and staging verification makes no live readiness claim. |

## Open Questions

- None.

## Deferred / Future Work

- [#240](https://github.com/lingkaix/openkit/issues/240) is outside prerelease cadence work and required before the first stable release, together with #225. [The corrected priorities](../decisions/20261014-release_cadence_corrections.md) record the ruling.
- [#225](https://github.com/lingkaix/openkit/issues/225), immutable stable promotion without rebuild, is required and rehearsed before the first stable release. Stable preflight remains closed until then.

- Publish another NanoHost platform only after its owner admits a real consumer, target, artifact, and acceptance evidence; source-level platform support does not create a release asset.
- Add build provenance attestations, image signing, SBOM generation, or vulnerability gates only after an accepted verification and consumer policy activates the deferred image-packaging work.
- Publish the internal dogfood image only after its existing design activation condition is met; it remains excluded from product release tags.
- Add a protected GitHub release environment or tag rules only after repository publication or observed unauthorized-tag risk demonstrates the need.
- Publish npm packages only after an external independently versioned package consumer exists.

## Links

- `docs/cookbooks/release.md`
- `.github/workflows/ci.yml`
- `scripts/release-preflight.mjs`
- `scripts/release-image-state.mjs`
- `containers/images.json`

### Exact-Head Pre-Merge And Release Coordination

The pre-merge command MUST validate the exact committed remote branch head with the complete release gate and all L0-L2 shards before an explicitly requested ordinary fast-forward to main. It MUST refuse changed source, dirty inputs, non-ancestral main, changed main, missing jobs, failed or skipped jobs, and stale attempts. No merge commit or force push may replace the tested SHA. Main-push reuse remains limited to that exact SHA and retains the execution evidence. This command controls its own writes; without repository protection it cannot prevent another writer from bypassing this process. Changing remote protection remains a separate security decision.

Release preparation MUST derive commit identities from actual Git objects, collect the complete paginated issue backlog, compare it with the previous reconciliation, retain missing and reopened issues, preserve existing known-issue text for review, and compare publication inputs with the proved baseline. The generated notes and classifications remain drafts. The human reviews meaning and dispositions before commitment and P selection. A legacy Markdown reconciliation has no observed issue metadata; its first delta MUST mark that uncertainty instead of inventing an unchanged classification. Later complete snapshots permit incremental review. A new closed issue is retained in the complete snapshot and notes facts; it needs no repeated open-issue disposition. Every authored SHA reference MUST resolve to an actual commit before admission.

The coordinator MUST collect current exact-P CI, main membership, complete issue observations, actual baseline publication and unused immutable release identities before the existing offline admission check. It MUST NOT manufacture a grant, approval, review or risk disposition. The reviewed issue snapshot hash MUST equal the observed complete snapshot. A tag effect requires a second unchanged collection and successful offline admission immediately before local tag creation and ordinary tag push. A changed observation or unknown push outcome stops for inspection. Same-tag recovery retains its existing immutable-retry rules and does not recreate the tag. Private evidence stays outside tracked files; the coordinator creates an exclusive private output directory. Stable publication is excluded.

Routine post-publication smoke MAY use the checksum-verified published operations CLI against an explicit development-machine loopback origin. It MUST bind that origin to the inspected running App container, verify the published tag and publication run, compare reported App source/tag and OCI index/platform identity, and run only described read-only public operations. Retained read results are compared with prior canonical result digests. Each CLI call is bounded to thirty seconds. Failure or timeout produces a failed observation and invokes investigation or an affected catalog story. This smoke performs no deployment update or reset, supplies no Worker qualification, and replaces no required release-cycle or affected-change L6 story. The live update adapter remains a separate dependency. Evidence contains identities, result digests and times, without private operation transcripts or credentials.


### Hosted Scratch Fixture

Only for a prerelease publication-path rehearsal in the existing `notrucked/openkit` repository under the standing scratch grant, a fresh disposable App fixture MAY run on a standard GitHub-hosted Linux amd64 runner. After successful publication and verification, it MUST use the exact published index and amd64 manifest and the checksum-verified published CLI. The job MAY use its GitHub-created token with only the required repository-read and package-read permissions. It MUST NOT import engineer credentials or expand package access. Fixture authentication MUST be synthetic, private, and temporary. The fixture MUST retain the same synthetic Data Root and prior canonical public-read hash across an observed App restart. Cleanup MUST remove only attempt-owned fixture resources. Evidence MUST bind repository, tag, P, publication run and attempt, reviewed control revision, smoke run and attempt, immutable artifact identity and checksum, and actual observation times. A local verifier MUST check these bindings against repository APIs and reject missing, stale, failed, or mismatched evidence. Only the non-secret result may leave the runner. This exception grants no real-repository write, stable publication, Latest mutation, visibility change, credential expansion, or production access. It replaces no real prerelease gate, named deployment observation, update, Worker qualification, or required L6 story. The existing development-machine smoke entry point and requirements remain unchanged.

The equivalence claim is limited to host-independent Linux amd64 predicates and one selected synthetic Workspace read. A normal restart is not a crash test, and equal selected read hashes prove no complete-data, upgrade, migration, rollback, arm64, Worker, NanoHost, actual development-host or L6 result. The fixture records its prior hash before stopping the App, verifies stopped state and a changed process start time after start, and retains the same image and Data Root. Missing restart or unresolved cleanup refuses completion. The local verifier supplies the API-assigned artifact ID and archive digest after upload; a record cannot authenticate itself. It independently checks the current successful publication and smoke attempts, exact reviewed workflow/control source, asset and image identities, fixed read inputs, restart/cleanup observations and the declared observation window. A new download never refreshes that window. Failure or expired evidence requires inspection and a new authorized attempt, never a claim from old results. This exception adds no durable service, release asset or new credential.


The root unit lane and root L0-L2 shard MUST select all Node test files under `scripts/**` recursively, together with the existing root tests. A script that declares itself a container subject MUST remain in exactly one explicit full-gate host job and MUST NOT execute again in the root container. Missing, duplicated or non-full host ownership refuses the inventory. The root shard retains its selected file list, and the aggregate MUST compare it with the exact-P inventory, including cardinality. Exact-P reuse retains that same file list and the original execution citation. This includes newly merged script tests without a hand-maintained file list. The separate explicitly opted-in Python host fixtures retain their existing admission and do not become automatic deterministic tests.

When P29's native inspection test is selected, the root lane MUST require Linux, the P02 live inspection producer in the same checkout, and the exact NanoHost-owned Rust pin. It MUST fetch the NanoHost manifest's locked Cargo inputs before the test's offline native fixture compilation. A restored cache alone is not proof of those prerequisites. The root lane MUST refuse a test-only producer selector; its native fixture MUST use that same checkout. Missing producer, wrong compiler, or failed locked input preparation refuses the lane before test execution. The P29 collection contract requires all five archive-attribution, host-observation, update-worker-environment, operator-inspection and native-inspection test files exactly once; later script tests remain automatic additions to the recursive inventory.
