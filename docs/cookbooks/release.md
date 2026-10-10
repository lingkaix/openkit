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

8. Run L4 Web e2e when the release decision requires that additional confidence. Run any selected L6 story under its admission and adjudication contract; the first-release rounds below remain a separate manual readiness requirement.

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

10. For the pre-release execution-authority replacement, complete the separately authorized [fresh-root cutover](persistent-live-acceptance.md#pre-release-execution-authority-cutover) before counting acceptance. Freeze exact tested commit T and the scenario revision in the release change record, then run the [first-release scenario set](#first-release-scenario-set) through the [maintained round kit](persistent-live-acceptance.md#maintained-round-kit). Apply the [Release Exit Criterion](../specs/20260829-release_management.md#release-exit-criterion) to the retained ordered rounds before exercising publication authorization. Publication selects T or a later `main` commit P only after the product-input comparison below exits 0. The tag workflow rebuilds published artifacts from P and verifies their exact digests and assets; it does not claim byte identity with the tested deployment.

### Tested And Publishing Commits

Retain full T and P and run this proof from the publishing checkout before tagging, including when P equals T:

```bash
node scripts/release-product-inputs.mjs --tested <T> --publishing <P>
```

Retain the classified diff, exit status and command output in the release record. Only `docs/**`, `tests/**`, `.github/**` and root Markdown files are non-product for this proof. Every other path, including scripts, Skills, containers, all app/package files, lockfiles, root manifests, unknown paths, and symlinks or gitlinks anywhere, is product. A product-input change, any change to the "First-Release Scenario Set" section, or a new product defect resets the count; a proved non-product-only T-to-P diff preserves it. The existing incomplete-round, configuration-change, repair and evidence-attribution rules still apply. Published bytes are verified separately.

Dispatch candidate CI with `gate=release-gate` or `gate=full` on exactly P and retain its successful completed `workflow_dispatch` run and job evidence. If P differs from T, dispatch its own candidate CI; a run on T cannot establish P. Candidate CI may overlap live rounds, but publication waits for both obligations. Each L0-L2 and NanoCore e2e tag job reuses only its own successful latest-attempt job in a completed same-workflow dispatch on the exact tagged commit, records the supporting run, and otherwise runs its tests as before.

### Publication-Path Proof Before Tagging

For each image publish/promotion, GitHub Release creation/upload, and published-release verification job, retain an earlier real tag run's successful execution plus the comparison showing that job unchanged since that run. For rc.3 the designated proof is the `v0.1.0-rc.2` tag run, to be recorded with successful job evidence and a comparison showing the publication jobs unchanged since `d3423328`; this designation alone proves no run result.

Rehearse a changed publication job before the real tag in a scratch repository under a different GitHub owner, with its own package coordinates so the real package names, tags and Latest pointers remain untouched. Obtain the engineer's authorization at that time before creating the scratch target or packages; rc.3 publication authorization does not grant that separate effect. Retain the real rehearsal result and changed-job comparison. An unchanged proved job needs no fresh rehearsal. A skipped job, missing result or conflicting proof leaves this obligation unproved.

### Scheduling The Round

Run the four runtime groups one after another because the deployment admits one active Worker Turn, under [Runtime Scheduling Scale](../specs/20260703-runtime_scheduling_scale.md) and deferred [issue #204](https://github.com/lingkaix/openkit/issues/204). Within each group keep the existing sequential A to D Turns. Evidence collection, the Chat row and the external Actor's reads may each overlap Worker rows only when that work holds no Worker. Whether the Chat row holds a Worker on this deployment is not verified, so the runner currently runs all rows sequentially. Overlap is permitted, not required. Task and Goal work that holds a Worker must respect the same single slot. This scheduling clarification changes none of the 21 scenarios, expected outcomes, deciding records or no-retry rule and is not a scenario-set change. It lives outside the frozen checklist section; any actual edit to that section still resets the count under the release owner.

Current observations in the rc.3 consultation's sequential baseline were about 49.8 and 39.4 minutes for rounds 15 and 16, or about 40 to 50 minutes per round. Use those observations for planning, not as limits, timeouts or grounds to truncate evidence. The consultation allowed 70 to 100 minutes for two sequential rounds, candidate CI of 25 to 65 minutes overlapping them, 5 to 15 minutes for routine compact summaries and non-pass checks, and 30 to 60 minutes for tag build/publication/verification with L0-L3 reuse. Its roughly 110 to 185 minutes from freeze to verified publication excludes implementation and focused review and assumes no additional rehearsal. These are planning inferences from current observations; no four-way speedup is established for rc.3.

## First-Release Scenario Set

This checklist projects the release owner's fixed-set rule; it creates no product contracts or story runner. Freeze its revision under the engineer-approved first-release scope before counting rounds. Record the exact candidate source commit and, per round, the App, Web, NanoHost and Worker artifact identities, retained component attribution, protected configuration identities without secret values, and the approved deployment target. Run the same source commit through every scenario in each round. The sixteen runtime cases plus deployment, Chat, Task, Goal and external-Agent cases make twenty-one scenario outcomes per round.

Declare a read-only GitHub issue with independently checkable title and state, a separate small issue authorized for an acceptance branch and pull request, and attempt-owned Workspace, Thread, filename and marker inputs. Keep the selected issue and output criteria fixed across counted rounds; vary only equivalent fixtures or attempt-owned names as the owner permits. Do not reuse unrelated user work or broaden credentials to repair a prerequisite. Scenario selection authorizes no live deployment, Provider consumption, GitHub write or approval resolution; obtain the existing effect-specific authority before execution.

Use public reads for the deciding product results and retain the returned ids and coverage. A terminal Turn alone does not prove its promised output. Inspect complete required Items, Artifacts, capability-call evidence and Pending Requests; note pagination and missing evidence. Use operator evidence for deployment byte identity and diagnostics only, without turning private database or host writes into a product success oracle. Installation qualification, destructive recovery and NanoHost containment remain separate proofs under their owners.

### Deployment Through The Maintained Exact-Source Procedure

Install or update the exact candidate source commit on the persistent deployment as an authorized external operator through the maintained [exact-source deployment procedure](persistent-live-acceptance.md#update-an-exact-source-build) during each round's coordinated maintenance window. Preserve the retained Data Root and protected configuration. For the second round deploy the same exact source commit through that maintained procedure; rebuilding it between rounds does not reset the count. Retain each round's install/update result and receipt, exact deployed artifact identities and any unchanged-component attribution. Publication later rebuilds artifacts from the proved publishing commit P under the release owner; the tag workflow verifies those published bytes without claiming they are byte-identical to either tested deployment.

Expected outcome: the selected bytes serve the public health endpoint and Web entry, authenticated App diagnostics show their readiness, retained Workspace records remain readable, and the public NanoHost runtime-target read shows readiness before Worker admission. Proof: public health response, rendered Web entry, authenticated diagnostics, Workspace read and runtime-target record, together with the maintained procedure's retained deployment record of the install/update result, full candidate commit, archive digest, smoke result, observed image/container and boot identities, exact deployed artifact identities and any unchanged-component attribution. This persistent-deployment observation does not claim fresh-install or cold-start qualification.

### Codex, Pi, OpenCode V2 And DeepSeek

Execute every row below separately for each of Codex, Pi, OpenCode V2 and DeepSeek using its configured real Worker path. That is four scenarios per runtime, not permission to substitute one runtime's pass for another's. Use a fresh Workspace-visible Thread for each runtime, retain its selected Agent and model/configuration identity, and execute sequential Turns on that same Thread after the preceding Turn is terminal. Accepted external behaviour retains its own classification under the release owner rather than becoming a fabricated successful output.

| Scenario for each runtime | Expected observable outcome | Public record that proves it |
| --- | --- | --- |
| Plain reply | A bounded request returns the declared marker as an assistant reply and the Turn ends normally. | The exact Turn read and its completed assistant-message Item on the named Thread. |
| GitHub issue read through Gateway MCP | The Worker reads the designated issue through the Gateway-mediated GitHub MCP and reports its independently checked title and state without modifying GitHub. | The Turn and reply Item, completed GitHub read tool/capability-call evidence, and the GitHub issue's public read record. |
| Workspace file write | Ask the Worker to write the declared marker to an attempt-owned file in its authorized writable output root, read it back, submit the finished file with `work_submit_artifact` using the declared filename as its title, and report the matching filename and contents. | The exact terminal Turn, completed assistant Item, completed same-Turn `artifact-reference` Item for the submitted Artifact, and `artifact.read` of the submitted Artifact id. The Artifact's `turn-output` origin must identify that Turn, its title must match the declared filename, its exact UTF-8 `content.body` bytes must match the declared marker, and recomputing their digest must verify `contentDigest`; neither SSH nor the assistant's assertion is file proof. |
| Follow-up Turn on the same Thread | Ask a new Turn to read the earlier file again, submit it with `work_submit_artifact` using the same declared filename as its title and a new submission request id, and report the same filename and contents. The preceding Thread history remains readable. | The same Thread id, distinct terminal Turn ids, retained earlier Items and the requested follow-up assistant output prove conversation continuity. The follow-up Turn's completed same-Turn `artifact-reference` Item for its own submitted Artifact and `artifact.read` of its own submitted Artifact id prove file content: the `turn-output` origin must identify the follow-up Turn, the title must match the earlier filename, the exact UTF-8 `content.body` bytes must match the earlier Artifact and declared marker, and recomputing their digest must verify `contentDigest` and match the earlier Artifact's digest. An assistant assertion alone is not file-content proof. |

Worker-produced public file evidence uses synchronous `work_submit_artifact` on the built-in work MCP supply under [Worker Runtime Communication Model](../specs/20260629-worker_runtime_communication_model.md#workspace-and-artifact-plane-projections) and [Worker Agent Capability](../specs/20260703-worker_agent_capability.md#built-in-work-target). Finish writing before submission; the path must be a canonical absolute POSIX strict child of exactly one admitted output root with `registerAsArtifacts=true` and `retention=sync-on-turn-end`. Use the existing Artifact kind `file` and media type `text/plain` for the declared marker. The [Artifact owner](../specs/20260713-work_resource_interaction_model.md#artifact-and-item-lineage) binds the returned Artifact id to the producing Turn and submission request, with exact captured bytes and digest publicly readable through `artifact.read`. Artifact reads expose a title rather than a separate filename field; using the declared filename as the submission title makes the filename comparison explicit without claiming a public filesystem-path attestation. A follow-up Turn submits the same path under its own new request; the earlier Artifact remains immutable. The proof is the verified exported copy captured during each call, not a filesystem snapshot or an assistant assertion. Keep all eight file cases in the fixed set; do not substitute operator import, an assistant-reported marker, a test-authored declaration or an invented submission procedure.

### Chat-Mode Exchange

Submit one simple question through the supported Chat surface and inspect the reply. Expected outcome: an ordinary assistant exchange returns a meaningful answer on the addressed Thread without delegating worker work. Proof: the public `conversation.submit` result with `targetRef=internal-role:assistant`, `outcome=answered`, `handoff=null`, and identical originating and receiving Workspace/Thread ids, the exact completed Turn with `agentId=quick-chat`, and its completed assistant-message Item on that addressed Thread. Inspect the complete Thread Turn and Item reads to verify that this exchange created no delegated Worker Turn or handoff Item; dashboard work-status fields do not prove a product mode or routing decision. [Chat Mode](../specs/20260704-chat_mode_assistant.md) owns that boundary.

### Task-Mode Issue To Open Pull Request

Start an explicit bounded Task for the designated GitHub issue through the supported product surface. Ask for the small issue fix and an opened pull request on its acceptance branch. The Worker uses the Gateway-mediated GitHub MCP; do not use the retired NanoCore host Git publication path. Allow issue and repository reads without write approval. Resolve Pending Requests only for the authorized branch writes, including branch creation and file commit or push to that branch, and pull-request creation for this issue and repository. Refuse merge, default-branch writes, unrelated repositories and other effects. Inspect each exact request before deciding; do not install a blanket write grant.

Expected outcome: the bounded Task produces the meaningful fix, pauses its governed external writes for the matching Pending Request decisions, and reaches a completed result with an open pull request against the declared base. Answered requests are delivered on later Turns of the same Task Thread under [Pending Requests](../specs/20260930-pending_requests.md); no step resumes a paused worker or invents an automatic Task loop. Proof: the public `task.start` admission result identifying the exact Task Turn and addressed Thread, its current-owner replay and the same [Task Mode](../specs/20260704-task_mode_worker_delegation.md) Thread and Turn reads, initiating and completion Items, GitHub capability-call evidence, exact Pending Request intents and granting actors plus recorded execution outcomes, and a fresh GitHub read of the branch, actual changed-file diff and open pull request. Inspect any produced diff Artifact as additional output evidence. An admission response, a granted approval, or a URL in the reply alone does not prove the pull request exists.

### Goal At The Shipped Scope

Create a small Goal with one bounded contribution, such as an acceptance note Artifact based on the designated issue, through the current [Goal operations](../specs/20261002-goal.md). Observe its intent, work-intent card and proposed immutable Plan version. The responsible person approves that exact version through its Pending Request. Observe activation and the Coordinator's admission of an ordinary Task linked to the current card revision and approved Plan. Inspect the Task's actual output. When the Coordinator calls accept completion with the exact candidate and evidence, the responsible person decides its Pending Request; observe consumption and the terminal completion disposition.

Expected outcome: no worker starts from creation or Plan approval alone, the approved Plan authorizes the linked Task without a second per-Task approval, and worker completion leaves the Goal open until the human completion grant is consumed. Proof: public Goal read with intent, card, immutable proposed/active Plan identity and digest, linked Task Thread and terminal Turns, readable output Artifact, Plan and completion Pending Requests with exact intents and deciding actors, and the final Goal disposition naming the accepted candidate. Effect-specific approvals remain separate when the chosen Task needs them. Do not add pause/resume, a recipe graph, Sandbox pin, automatic worker retry, Knowledge publication or a deferred evaluation loop to this scenario.

### External Agent Through Remote MCP

Start a fresh external MCP-capable Agent outside the source checkout with its protected scenario credential configured through the existing owner. Give it a persona and a single user goal, such as locating the designated shared Thread and explaining its latest completed result. Keep the checklist, assertions, expected answer and operator SSH tools outside the Actor's context. Let it discover the product through remote MCP rather than supplying an operation sequence.

Expected outcome: the independent external Agent completes the admitted user goal through the deployment's public remote MCP interface, using the guidance and tools it needs without a prescribed call sequence, and returns an answer grounded in the designated public record on that same deployment. Proof: retained redacted MCP tool descriptions and the requests and responses actually used, served build identity and client/version, the exact Workspace/Thread/Turn or Artifact record it read, and independent recomputation of its deciding fact. Apply [Persistent Deployment Acceptance](../specs/20260909-persistent_deployment_acceptance.md) and, when run as L6, its admitted story and independent Judge rules; a spot check by the operator alone does not prove the external-Agent flow. Missing an observation required by the governing owner leaves that observation incomplete; not invoking an offered tool, including `guide`, does not by itself make this scenario incomplete.

## Record And Classify Every Round

Use the [release owner's compact record](../specs/20260829-release_management.md#compact-release-record): one release-level header and one row per round, with exactly these columns:

| Round | Tested candidate / frozen set | Deployment identity / window | Per-scenario outcomes | Counts / sequence | New defects / other dispositions | Retained evidence / non-pass checks |
| --- | --- | --- | --- | --- | --- | --- |
| <order> | <full T; frozen checklist identity> | <App, Web, NanoHost, Worker digests and retained attribution; non-secret configuration identity; UTC start/end> | Deploy=<code>; Codex A/B/C/D=<codes>; Pi A/B/C/D=<codes>; OpenCode V2 A/B/C/D=<codes>; DeepSeek A/B/C/D=<codes>; Chat=<code>; Task=<code>; Goal=<code>; External=<code> | Executed=<n>; incomplete=<n>; successful=<n>; new=<n>; known=<n>; external=<n>; complete=<yes/no>; clean=<yes/no>; consecutive=<n>; reset reason=<reason/none> | <new defect references; known/external/environment/tool/inconclusive/cleanup/blocker dispositions> | <neutral evidence alias and digest; runner commit and digest; parameter-file digest; independent check reference for each non-pass or undecidable row> |

Codes: P pass, K known defect, E accepted external, N new defect, T environment or tool failure, I inconclusive. The kit regenerates verdicts from retained product records. Independently check each non-pass and each row it cannot decide; pass rows need no additional narrative review. Preserve scenario-owned independent proof, including the external Actor's deciding recomputation and any L6 Judge. A clean round still may contain failed workflows under known-defect or accepted-external dispositions; stop only when the required consecutive complete clean rounds and all other release obligations are proved.

Keep complete evidence privately, including every scenario's declared input, runtime/model, Workspace/Thread/Turn ids, expected and observed outcomes, public records, full required read coverage, classification and defect linkage, deployment receipt and attribution. The public record uses neutral evidence aliases and digests, never host names, private paths, Thread ids or transcripts. Use the public `tests/support/release-round.mjs` runner through its one entry point and subcommands, documented with its parameter fields in the [tests guide](../../tests/README.md). Supply a private parameter file containing every deployment-specific value and no secret value, kept outside the repository or under ignored `temp/`; use only synthetic placeholders in examples. Create one new private evidence directory per round and never reuse it. Pin the runner's commit and digest and the parameter-file digest per round; its summarize mode regenerates verdicts and the compact row from retained evidence without product effects. Do not copy or literally edit per-round scripts. An instrument correction under `tests/**` is non-product under A, subject to current harness admission and evidence completeness. The operator reads each Pending Request in full before deciding it; the runner performs no automatic retry, repair or approval. Retain failed and incomplete rounds and previous outcomes rather than retrying them away.

Privately retain the round-window HTTP 502 and connection-reset counts, with explicit zeroes only where covered. Keep client-visible occurrences and available proxy/App coverage separate, correlate overlapping observations rather than double-counting log lines, and retain timestamp, route, safe cause and request correlation when available. Missing coverage is unavailable, not zero. Keep Worker failure counts by runtime and Task/Goal scenario, counted by distinct Turn, with each published failure code and cause verbatim after redaction, associated product records and classification. A failed Turn with no published cause has unavailable cause evidence, not an inferred Provider failure. Retain known defect records predating the round, new defects, accepted-external boundary evidence, environment/tool failures, missing observations, cleanup outcomes and unresolved blockers with the private evidence.

Optional telemetry remains diagnostic under Persistent Deployment Acceptance; its absence is recorded separately from public product outcomes. A 502, reset or Worker failure requires attribution and is not automatic permission to classify it as external. Missing required product evidence makes the scenario incomplete. The release owner decides readiness; exact-tag publication authorization remains separate.

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
