# Release Cookbook

Use this cookbook to prepare, authorize, publish, verify, and record one OpenKit product release.

The owning contract is [`docs/specs/20260829-release_management.md`](../specs/20260829-release_management.md).

## Current Release Posture

The first formal release path starts at `v0.1.0-rc.1`.

The tag workflow currently rejects stable tags because the exact-product R001 NanoHost runtime gate remains open; both controlled NanoHost targets are implemented with hosted distribution qualification wired into release and pre-release CI.

Do not change the release preflight CLI's prerelease-only default until an accepted owner closes that stable-release blocker.

The repository is public, and only `worker-common` is required to be anonymously public in GHCR.

Do not change repository or package visibility as an implied part of preparation or publication.

## Release Bundle

One lowercase semantic-version tag identifies the complete product bundle:

- every `release: true` image in `containers/images.json`,
- `openkit-ops-skill-<tag>.tar.gz`, containing `LICENSE` and the complete operations Skill tree with its generated administrator executable,
- `openkit-nanohost-<tag>-linux-amd64.tar.gz` and `openkit-nanohost-<tag>-linux-arm64.tar.gz`, each containing the verified NanoHost binary, pin-bound Gateway, service unit, installer, bundled capability profile, generated profile/provenance metadata, checksums, and licenses,
- `SHA256SUMS` for all three portable archives,
- one GitHub Release with image digests and gate evidence.

Private workspace packages are not npm release assets, and their `package.json` versions do not follow the product tag.

`test-env`, the internal dogfood image, and GitHub-generated source archives are not controlled product release assets.

## Prepare The Release

1. Start from an up-to-date `main` and create a preparation branch.

```bash
export OPENKIT_RELEASE_TAG=v0.1.0-rc.1
git switch main
git pull --ff-only
git switch -c "release/${OPENKIT_RELEASE_TAG}"
```

2. Create `docs/changes/<timestamp>-<version>_release/plan.md` and record one release-level header with the intended tag and controlled asset set, publication authorization and conditions, tested commit T and publishing commit P, classified non-product diff and comparison result, candidate CI proof, visibility posture, frozen checklist identity, and known-defect dispositions. Record the manual-gate decision and known limitations with their existing owners.

3. Update user-facing notes and any accepted owner affected by the release contents. For the pre-release execution-authority replacement, record the separately authorized [stopped, fenced, fresh-root cutover](persistent-live-acceptance.md#pre-release-execution-authority-cutover); no execution-graph migration is supplied.

Do not mass-update package versions.

4. Run release preflight.

```bash
pnpm release:preflight -- --tag "${OPENKIT_RELEASE_TAG}"
```

Preflight validates lowercase tag syntax, portable Skill and NanoHost inputs, the schema-version-2 NanoHost capability profile, the accepted OpenShell pin, the release image catalog, smoke paths, the unique public worker base, and digest-pinned bases for every release image.

5. Build the portable operations Skill from the commit that would be released and inspect it. For full NanoHost packaging, supply both native binary and Gateway archive inputs plus the common license inputs listed in the [scripts guide](../../scripts/README.md#release-inputs-and-verification).

```bash
pnpm release:package -- --tag "${OPENKIT_RELEASE_TAG}"
(cd dist/release && sha256sum -c SHA256SUMS)
tar -tzf "dist/release/openkit-ops-skill-${OPENKIT_RELEASE_TAG}.tar.gz"
```

The Skill packager uses `git archive`, and NanoHost packaging reads its checkout-owned files from the selected Git revision, so uncommitted files are intentionally excluded. The tag workflow obtains the NanoHost binary from native amd64 and arm64 build jobs and downloads the Gateway and source-license bytes from the pin-derived coordinates before invoking the same target-aware packager and verifier. The tag-only hosted qualification matrix consumes those exact packaged archives before either image or GitHub Release publication; it runs no service or Worker job and does not run on pull requests or workflow dispatch.

After outer checksum verification, extract the NanoHost archive beside its original `.tar.gz` and run the bundled `./install.sh --check-host` on the selected Linux host. Retain its exact JSON result, including profile/product/archive/machine/observation digests, hard verdict, and separate resource recommendation. Checking and installation, including staging verification, require Python 3.8 or later with its standard library at `/usr/bin/python3`; the NanoHost service does not depend on it. Missing or unusable inspection yields one bounded `cannot-check` result and blocks installation; a completed mismatch yields `requirements-unmet`. `requirements-met` permits installation preflight and establishes no runtime qualification. The shared staging verifier keeps its host-check exemption. Fresh exact-product distribution qualification runs only in release and pre-release CI under the [engineer ruling](../decisions/20261005-first_release_lifecycle_and_verification_scope.md). Historical exact Docker or slirp identity passes do not qualify the current profile; runtime acceptance remains separate.

6. Run the automatic release gate locally.

```bash
pnpm verify:release
```

7. When Docker is available, build and smoke each release image on the local host architecture.

```bash
for image in $(node -e "const m=require('./containers/images.json'); console.log(m.images.filter((i)=>i.release).map((i)=>i.id).join(' '))"); do
  scripts/docker/build-image.sh "${image}"
  scripts/docker/smoke-image.sh "${image}"
done
```

The tag workflow remains authoritative for both declared platforms because it smokes the exact pushed digest for `linux/amd64` and `linux/arm64` before promotion.

8. Run L4 Web e2e when the release decision requires that additional confidence. Before the tag, run deterministic CI only. After the tag, run every catalog story on the published prerelease. Follow [Post-Tag Catalog Stories](#post-tag-catalog-stories). Worker qualification is separate.

```bash
pnpm test:e2e:web
```

Real-provider, real-subscription, and real-worker gates remain explicit opt-ins and must not be added to automatic tag CI merely for a release.

9. Commit the preparation, obtain normal review, merge it to `main`, and confirm the release commit is clean and contained in `origin/main`.

Each new release tag must point to a commit that has not already been released because the immutable source-revision image tag is part of one release identity; a same-tag rerun continues to use the original commit.

```bash
git switch main
git pull --ff-only
git status --short
git merge-base --is-ancestor HEAD origin/main
pnpm release:preflight -- --tag "${OPENKIT_RELEASE_TAG}"
```

10. For the pre-release execution-authority replacement, complete the separately authorized [fresh-root cutover](persistent-live-acceptance.md#pre-release-execution-authority-cutover) before the tag when that cutover is still required. Before the tag, complete deterministic CI, candidate CI, and publication-path proof. The catalog stories are not a pre-tag gate, and a story run on an unpublished candidate is not release evidence. The tag workflow builds the prerelease once. Stories run on those published bytes. Apply the [Release Exit Criterion](../specs/20260829-release_management.md#release-exit-criterion) after the tag.

### Candidate CI

Dispatch candidate CI with `gate=release-gate` or `gate=full` on the exact commit you will tag. Retain its successful completed `workflow_dispatch` run and job evidence. A run on another commit does not establish this commit. Each L0-L2 and NanoCore e2e tag job reuses only its own successful latest-attempt job in a completed same-workflow dispatch on the exact tagged commit, records the supporting run, and otherwise runs its tests as before.

### Publication-Path Proof Before Tagging

For each image publish/promotion, GitHub Release creation/upload, and published-release verification job, retain an earlier real tag run's successful execution plus the comparison showing that job unchanged since that run. Record that run, its successful jobs, and the comparison. The designation of a past run does not by itself prove a result.

Rehearse a changed publication job before the real tag in a scratch repository under a different GitHub owner, with its own package coordinates so the real package names, tags and Latest pointers remain untouched. Obtain the engineer's authorization at that time before creating the scratch target or packages; rc.3 publication authorization does not grant that separate effect. Retain the real rehearsal result and changed-job comparison. An unchanged proved job needs no fresh rehearsal. A skipped job, missing result or conflicting proof leaves this obligation unproved.

### Scheduling Worker Qualification

Run the four runtime groups one after another because the deployment admits one active Worker Turn, under [Runtime Scheduling Scale](../specs/20260703-runtime_scheduling_scale.md) and deferred [issue #204](https://github.com/lingkaix/openkit/issues/204). Within each group keep the existing sequential A to D Turns. Evidence collection may overlap a Worker row only when that work holds no Worker. Overlap is permitted, not required. The stage manager never retries, repairs, or approves on the actor's behalf.

The independent check and final summary of a finished qualification hold no Worker. Current observations in the rc.3 consultation's sequential baseline were about 49.8 and 39.4 minutes for rounds 15 and 16, or about 40 to 50 minutes per round. Use those observations for planning, not as limits, timeouts, or grounds to truncate evidence.

## Post-Tag Catalog Stories

After the tag, run every story in the [L6 catalog](../specs/20260529-l6_story_acceptance.md#catalog) on the published prerelease. The catalog stories are not a pre-tag gate, and a story run on an unpublished candidate is not release evidence. Story 1 runs on a disposable host. Story 2 runs on the persistent deployment that carries the previous release's real data. The [Release Exit Criterion](../specs/20260829-release_management.md#release-exit-criterion) owns pass, defect, and rerun. This cookbook does not copy the catalog.

Declare a read-only GitHub issue with an independently checkable title and state, a separate small issue authorized for an acceptance branch and pull request, and attempt-owned Workspace, Thread, filename, and marker inputs. Vary only equivalent fixtures or attempt-owned names. Do not reuse unrelated user work or broaden credentials to repair a prerequisite. Story selection authorizes no live deployment, Provider consumption, GitHub write, or approval. Obtain the existing effect-specific authority before execution.

Use public reads for the deciding product results and retain the returned ids and coverage. A terminal Turn alone does not prove its promised output. Inspect complete required Items, Artifacts, capability-call evidence, and Pending Requests. Note pagination and missing evidence. Use operator evidence for deployment byte identity and diagnostics only. Do not turn a private database write or a host write into a product success result. Installation qualification, destructive recovery, and NanoHost containment remain separate proofs under their owners.

## Worker Qualification

Run the matrix below on the deployment that catalog story 2 updated. It is not a story and not a pre-tag round. Record the published prerelease identity and, for each case, the App, Web, NanoHost, and Worker artifact identities, retained component attribution, protected configuration identities without secret values, and the approved deployment target. The [Release Exit Criterion](../specs/20260829-release_management.md#release-exit-criterion) owns pass, defect, and rerun. The release record retains this evidence before stable promotion.

### Codex, Pi, OpenCode V2 And DeepSeek

Execute every row below separately for each of Codex, Pi, OpenCode V2 and DeepSeek using its configured real Worker path. That is four scenarios per runtime, not permission to substitute one runtime's pass for another's. Use a fresh Workspace-visible Thread for each runtime, retain its selected Agent and model/configuration identity, and execute sequential Turns on that same Thread after the preceding Turn is terminal. Accepted external behaviour retains its own classification under the release owner rather than becoming a fabricated successful output.

| Scenario for each runtime | Expected observable outcome | Public record that proves it |
| --- | --- | --- |
| Plain reply | A bounded request returns the declared marker as an assistant reply and the Turn ends normally. | The exact Turn read and its completed assistant-message Item on the named Thread. |
| GitHub issue read through Gateway MCP | The Worker reads the designated issue through the Gateway-mediated GitHub MCP and reports its independently checked title and state without modifying GitHub. | The Turn and reply Item, completed GitHub read tool/capability-call evidence, and the GitHub issue's public read record. |
| Workspace file write | Ask the Worker to write the declared marker to an attempt-owned file in its authorized writable output root, read it back, submit the finished file with `work_submit_artifact` using the declared filename as its title, and report the matching filename and contents. | The exact terminal Turn, completed assistant Item, completed same-Turn `artifact-reference` Item for the submitted Artifact, and `artifact.read` of the submitted Artifact id. The Artifact's `turn-output` origin must identify that Turn, its title must match the declared filename, its exact UTF-8 `content.body` bytes must match the declared marker, and recomputing their digest must verify `contentDigest`; neither SSH nor the assistant's assertion is file proof. |
| Follow-up Turn on the same Thread | Ask a new Turn to read the earlier file again, submit it with `work_submit_artifact` using the same declared filename as its title and a new submission request id, and report the same filename and contents. The preceding Thread history remains readable. | The same Thread id, distinct terminal Turn ids, retained earlier Items and the requested follow-up assistant output prove conversation continuity. The follow-up Turn's completed same-Turn `artifact-reference` Item for its own submitted Artifact and `artifact.read` of its own submitted Artifact id prove file content: the `turn-output` origin must identify the follow-up Turn, the title must match the earlier filename, the exact UTF-8 `content.body` bytes must match the earlier Artifact and declared marker, and recomputing their digest must verify `contentDigest` and match the earlier Artifact's digest. An assistant assertion alone is not file-content proof. |

Worker-produced public file evidence uses synchronous `work_submit_artifact` on the built-in work MCP supply under [Worker Runtime Communication Model](../specs/20260629-worker_runtime_communication_model.md#workspace-and-artifact-plane-projections) and [Worker Agent Capability](../specs/20260703-worker_agent_capability.md#built-in-work-target). Finish writing before submission; the path must be a canonical absolute POSIX strict child of exactly one admitted output root with `registerAsArtifacts=true` and `retention=sync-on-turn-end`. Use the existing Artifact kind `file` and media type `text/plain` for the declared marker. The [Artifact owner](../specs/20260713-work_resource_interaction_model.md#artifact-and-item-lineage) binds the returned Artifact id to the producing Turn and submission request, with exact captured bytes and digest publicly readable through `artifact.read`. Artifact reads expose a title rather than a separate filename field; using the declared filename as the submission title makes the filename comparison explicit without claiming a public filesystem-path attestation. A follow-up Turn submits the same path under its own new request; the earlier Artifact remains immutable. The proof is the verified exported copy captured during each call, not a filesystem snapshot or an assistant assertion. Keep all eight file cases in Worker qualification. Do not substitute operator import, an assistant-reported marker, a test-authored declaration, or an invented submission procedure.

## Record And Classify

Use the [release owner's compact record](../specs/20260829-release_management.md#compact-release-record): one release-level header, one row per catalog story, and one row per Worker-qualification case.

Codes: P pass, K known defect, E accepted external, N new defect, T environment or tool failure, I inconclusive. The kit regenerates verdicts from retained product records. Independently check each non-pass row and each row it cannot decide. A pass row needs no additional narrative review. Preserve story-owned independent proof, including the actor's deciding recomputation and any L6 judge. Stop only when every catalog story and every qualification case has the evidence the release owner requires, together with every other release obligation.

Keep complete evidence privately, including every story's declared input, runtime and model, Workspace, Thread, and Turn ids, expected and observed outcomes, public records, full required read coverage, classification, and defect linkage, plus the deployment receipt and attribution. The public record uses neutral evidence aliases and digests. It never contains a host name, a private path, a Thread id, or a transcript. Use the public `tests/support/release-round.mjs` runner through its one entry point and subcommands, documented with its parameter fields in the [tests guide](../../tests/README.md). The runner does not build an image or replace a container. The runner keeps parameters, the evidence directory, browser preflight, actor provisioning, evidence collection, summarize, cleanup, and the Worker qualification groups. Supply a private parameter file containing every deployment-specific value and no secret value, kept outside the repository or under ignored `temp/`. Use only synthetic placeholders in examples. Create one new private evidence directory per run and never reuse it. Pin the runner's commit and digest and the parameter-file digest. Its summarize mode regenerates verdicts and the compact row from retained evidence without a product effect. Do not copy or literally edit per-run scripts. The stage manager never retries, repairs, or approves on the actor's behalf. An approval in a story is the actor's user action through a public surface. Retain failed and incomplete runs and previous outcomes. A later run does not erase them.

Privately retain the run-window HTTP 502 and connection-reset counts, with explicit zeroes only where covered. Keep client-visible occurrences and available proxy and App coverage separate. Correlate overlapping observations. Do not double-count log lines. Retain timestamp, route, safe cause, and request correlation when available. Missing coverage is unavailable, not zero. Keep Worker failure counts by runtime for each Worker-bearing catalog story and for each qualification case, counted by distinct Turn, with each published failure code and cause verbatim after redaction, associated product records, and classification. A failed Turn with no published cause has unavailable cause evidence. Do not infer a Provider failure. Retain known defect records that predate the run, new defects, accepted-external boundary evidence, environment and tool failures, missing observations, cleanup outcomes, and unresolved blockers with the private evidence.

A telemetry file in an L6 evidence bundle is diagnostic. Its absence is recorded separately from public product outcomes. A 502, a reset, or a Worker failure requires attribution and is not automatic permission to classify it as external. Missing required product evidence makes the run inconclusive. The release owner decides readiness. Exact-tag publication authorization remains separate.

## Publication Authorization

A green gate does not authorize publication.

Before creating the tag, obtain explicit engineer authorization for the exact value of `OPENKIT_RELEASE_TAG` and the release bundle listed above, then record that authorization in the release change record.

Creating or pushing any other tag requires new authorization.

## Publish

After exact-tag authorization:

```bash
git tag "${OPENKIT_RELEASE_TAG}"
git push origin "${OPENKIT_RELEASE_TAG}"
```

The tag push is the only publication trigger.

The workflow then:

- proves that the tagged commit belongs to `main`,
- records exact-commit same-workflow dispatch proof separately for L0-L2 and NanoCore e2e and skips those tests only when each same job succeeded in its latest attempt; otherwise runs that job's tests,
- runs L5 and every other tag job, including preflight, portability and main membership,
- runs the isolated fixed-path NanoHost installer gate without service lifecycle,
- builds the portable Skill and native amd64 and arm64 NanoHost assets,
- derives the image matrix from `containers/images.json`,
- pushes digest-only multi-platform image candidates,
- smokes each exact candidate digest on every declared platform,
- promotes the passed digest to immutable version and source-revision tags,
- preserves `latest` for prereleases,
- creates the GitHub prerelease with the three portable archives and their shared checksum attachment,
- downloads and independently verifies the final assets and image digests,
- logs out of GHCR and verifies the exact `worker-common` digest anonymously.

Watch the run until the terminal verification job completes:

```bash
gh run list --workflow CI --branch "${OPENKIT_RELEASE_TAG}" --limit 1
gh run watch <run-id> --exit-status
```

## First worker-common Publication

GitHub creates a new container package as private.

The first `worker-common` publish therefore stops at the anonymous exact-digest gate until a repository administrator changes that package to public.

This one-time visibility change is an explicit external effect; record its authorization and observed result, then rerun the failed workflow without moving the tag.

The rerun proves and reuses the existing version and source-revision digest instead of rebuilding or overwriting it.

## Verify And Close

The workflow's `Verify published release` job is the deciding automatic publication check.

After it passes, inspect the public record and copy the tag, source commit, workflow run, image digests, repository and package visibility, portable checksum, manual-gate disposition, and NanoHost limitation into the release change record.

```bash
gh release view "${OPENKIT_RELEASE_TAG}" --json tagName,isDraft,isPrerelease,assets,url
gh run view <run-id>
```

Close the release change record only when the workflow is green, the GitHub Release is published with exactly the three archives plus `SHA256SUMS`, both downloaded NanoHost archives pass the shared contained staging verifier, and `worker-common` is anonymously inspectable by digest.

## Failure And Retry

Never move, force-push, delete, or overwrite a published release tag or promoted image tag.

Before promotion, a build or smoke failure may be retried under the same tag because no release image tag exists.

After partial matrix publication, rerun the same tag only when the workflow proves that every existing version, version-without-`v`, and source-revision tag is complete and resolves to one recorded digest; matching images are reused and missing image identities are built.

A partial or conflicting tag set fails closed and requires operator inspection.

An existing published GitHub Release is immutable to the workflow; a rerun verifies it but does not edit notes or replace assets.

A current stable tag may be rerun only while its `latest` image tags still resolve to its recorded digests; a superseded stable tag or a stable publication that did not complete `latest` fails closed and requires a new stable tag on a new commit rather than moving `latest` backward.

A behaviorally incorrect or ambiguous promoted artifact requires a new prerelease or patch tag on a new commit and new exact-tag authorization.

Record every partial publication, failed boundary, observed digest, corrective decision, and superseding tag in the release change record.

## Web Bundle Size

Web bundle-size warnings are informational because the Web UI is a professional-workspace SPA and may later be embedded in a desktop application.

Do not split chunks or change the Vite warning threshold without a measured performance objective owned by an accepted Web change.
