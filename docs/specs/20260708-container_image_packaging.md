---
status: Accepted
implementation: Partial
kind: topology
aspect: architecture
---
# Container Image Packaging And Release Publishing

This specification owns the OpenKit container image taxonomy, the image catalog, and the publishing contract for OpenKit-owned images.

## Scope

Owns:

- The canonical container image taxonomy.
- The repository layout for Dockerfiles, image smoke scripts, and image metadata.
- The machine-readable image catalog used by local scripts and GitHub Actions.
- The version, tag, label, digest, and provenance rules for published images.
- The boundary between a published image and Core product truth.

Does not own:

- NanoCore runtime semantics — [Runtime Model](../core/runtime-model.md). Sandbox containment — [Sandbox](../core/sandbox.md).
- Worker-facing control, capability, and communication — [Worker Runtime Communication](20260629-worker_runtime_communication_model.md), [Worker Control Protocol](20260703-worker_control_protocol.md), and [Worker Agent Capability](20260703-worker_agent_capability.md).
- Agent Environment Package fields — [Agent Environment Package](20260616-agent_environment_package.md). OpenShell internalization — [OpenShell Mechanism Internalization](20260703-openshell_mechanism_internalization.md). Runtime Epoch and transport — [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md).
- Deployment host support — [Deployment Host Requirements](20260909-deployment_host_requirements.md). Kubernetes, Helm, Compose, installer, and desktop packaging are outside this specification.
- Product release composition, authorization, retry, and completion — [Release Management](20260829-release_management.md). npm publishing is outside this specification.

Core:

- [Architecture](../core/architecture.md)
- [Runtime Model](../core/runtime-model.md)
- [Sandbox](../core/sandbox.md)
- [Agent Supply](../core/agent-supply.md)
- [Mediation](../core/mediation.md)
- [Vault](../core/vault.md)
- [Evidence](../core/evidence.md)

## Decision

OpenKit will use one catalog-driven image packaging model.

The repository-owned image classes are:

| Image id | Release artifact | Purpose | Base image rule |
| --- | --- | --- | --- |
| `app` | Yes | Product app image containing NanoCore, Web UI, public HTTP entrypoint, migrations, and data templates. | Use the digest-pinned Node runtime base declared in the image catalog and matching repository Node policy. |
| `worker-common` | Yes | Published public extension base carrying the shared development environment and worker shim, with an empty declared runtime set. It is the extension point for user or secondary-developer sandbox images and the build base of the one deployment image. It is not a deployment image and it is not the `test-env` base. | Use the pinned digest-addressed upstream base under Worker Base Image Policy. |
| `worker-runtimes` | Yes | Sole deployment worker image. OpenShell sandbox payload whose catalog-declared runtime set is `codex`, `pi`, `opencode`, and `deepseek`, with the generic shim and four static adapters. | Use the pinned shared OpenKit development stage and add those four runtimes, the four adapters, and the exact built Pi SDK host with its patched native MCP/tool-search production dependency closure under [Worker Execution Environment Images](20260721-worker_execution_environment_images.md), with rationale recorded in [Pi Native MCP Discovery](../decisions/20260930-pi_native_mcp_discovery.md); `pi-mcp-adapter` is absent. |
| `test-env` | Never on a release tag; published for CI to consume | Internal sibling of `worker-common`, owned by `docs/toolchain.md` Test Execution Environment. Pins the same upstream Node digest independently and does not derive `FROM worker-common`. | Use the same digest-pinned Node base as the worker common stage and install only what the gates execute; no worker runtime. |

App image and worker images MUST remain separate release units. The one allowed exception is a single-machine evaluation bundle that an explicit deployment owns and names; a normal release build MUST NOT merge the app and worker units, and the app image MUST NOT bundle worker agent runtimes as its release model.

The app image is user-facing. It owns NanoCore startup, Web UI static assets, public HTTP routing, data-root layout, database migrations, app smoke checks, and packaged UI checks.

Worker images are backend payloads. They own agent runtime binaries, the generic OpenKit worker shim package, worker-visible `/openkit` layout, transcript output paths, runtime-native config materialization, and the manifest-selected adapter projection. They do not own product state, review decisions, workspace truth, vault truth, or public API semantics.

## Contract / Expected Behavior

### Image Manifest

The repository must define `containers/images.json`.

The manifest must be valid JSON. The example shows the required fields. Its Node digest is the current default pin. The manifest must include:

```json
{
  "schemaVersion": 1,
  "registry": "ghcr.io",
  "images": [
    {
      "id": "app",
      "repository": "openkit-app",
      "dockerfile": "containers/app/Dockerfile",
      "context": ".",
      "kind": "app",
      "release": true,
      "baseImage": "node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68",
      "platforms": ["linux/amd64", "linux/arm64"],
      "smoke": "containers/app/smoke.sh",
      "smokeCommand": "openkit-app-smoke",
      "localTag": "openkit/app:dev"
    }
  ]
}
```

Each image entry must include:

- `id`: stable local identifier used by scripts and CI.
- `repository`: GHCR package name suffix.
- `dockerfile`: repository-relative Dockerfile path.
- `context`: repository-relative build context.
- `kind`: `app`, `worker`, or `test`.
- `release`: whether normal version tags publish this image.
- `platforms`: build platforms.
- `smoke`: repository-relative smoke script.
- `smokeCommand`: in-container smoke command installed by the image.
- `localTag`: local development image tag used by helper scripts.

Image ids MUST be unique. Every release image MUST declare at least one platform. Every dockerfile, context and smoke path MUST exist within the repository.

Every release image entry must also include `baseImage`, a digest-pinned direct base reference.

`anonymousPull` is an optional boolean publication predicate; exactly one public release worker base sets it to `true`, and every other entry omits it or sets it to `false`.

Deployment worker image entries must also include:

- `runtimes`: a non-empty JSON array of catalog identifiers. The deployment image's array is `codex`, `pi`, `opencode`, `deepseek`, in that order. Omit this field when the declared runtime set is empty. `worker-codex`, `worker-opencode`, and `worker-pi` are not catalog ids and are not aliases.
- `workerContract`: a non-empty string containing the OpenKit worker contract version, `openkit-worker-v1`. Required exactly when runtime metadata exists, and forbidden when it does not. Whether the control-protocol owner bumps that string is that owner's question. This specification does not invent a bump.
- `target`: unique shared-Dockerfile build target.

A public release worker base is identified structurally by absent `runtimes` and explicit `anonymousPull: true`, not by a reserved image id. That entry must include `baseImage` and `target`, must omit `runtimes` and `workerContract`, and remains `kind: worker` so the existing catalog and release path can build, smoke, publish, and verify it without a parallel image class. The current such entry is `worker-common`. Release preflight must require exactly one such release worker base and must not special-case an image id. CI, preflight, and OCI-label consumers change together in the same reviewed change. This version starts from a new data root and does not read earlier-version data ([earlier-version data is not carried](../decisions/20260930-earlier_version_data_not_carried.md)).

The authored `AgentManifest`, not this packaging catalog or a backend-global environment variable, selects the governed image reference and declares the runtime binary ids and absolute worker-local executable paths. NanoCore resolves that declaration into the AEP without a runtime-specific image branch. `control.adapter.targetRuntime` selects exactly one adapter per session. The image entry records how the selected artifact is built, smoked, and published; it is not a second runtime selector, and image contents confer no authority.

The manifest may include optional build args, labels, target names, or publish policy fields when those fields are consumed by scripts and tested.

The manifest must not include secrets, tokens, private registry credentials, local absolute paths, or user-specific image names.

### Repository Layout

OpenKit-owned image Dockerfiles must live beneath `containers/`. An independently implemented image uses `containers/<image-id>/Dockerfile`; `worker-common` and `worker-runtimes` use the shared `containers/workers/Dockerfile` plus unique manifest targets owned by `docs/specs/20260721-worker_execution_environment_images.md`. An OpenKit-owned image that derives from a published OpenKit base is an independently implemented image and keeps its own directory and Dockerfile; deriving does not move it into the base's shared Dockerfile.

Each image directory must include a `README.md` when the image has operator-visible behavior beyond `docker build`.

Each release image directory must include a smoke script.

Root-level Dockerfiles are not image sources. Old Dockerfile paths, old image names, and old staging script names have no compatibility aliases. `worker-codex`, `worker-opencode`, and `worker-pi` are not aliases. Release preflight refuses those removed leaf ids.

`scripts/docker/` remains the home for repository-level image commands, but scripts must consume `containers/images.json` rather than hard-code the image catalog.

### App Image Contract

The app image must:

- package built NanoCore server artifacts,
- package built Web UI assets,
- package database migrations and data templates required for boot,
- expose one public HTTP port,
- keep NanoCore internals behind the public app routing layer,
- use a persistent `/data/openkit` data root by default,
- run in `server` mode for formal release images unless a release explicitly ships a local-only developer preview,
- provide a smoke command that verifies Node, NanoCore boot, `/api/health`, static Web UI routing, and data-root writability.
- carry its exact build identity in `/usr/local/lib/openkit/release-identity.json` from build-time `OPENKIT_SOURCE_COMMIT`, with `OPENKIT_RELEASE_TAG` when the build has a release tag. The closed core is `sourceCommit` (40 lowercase hex) and `releaseTag` (a v-prefixed SemVer tag, or null for an untagged source build). Release and prerelease candidate builds supply both values. The local App image script supplies the clean checkout commit, or an explicit source input; an unlabelled dirty build and a local dev run without injected input remain unknown and never infer identity at runtime. A build without either input omits the file. Unknown additive keys are ignored. A missing file means unknown build identity and no release tag. A present file that is invalid JSON, has an unknown core shape, or carries a value outside that closed core fails NanoCore boot configuration with `invalid_release_identity` and MUST NOT be reported as a release identity.

The identity MUST be that file and MUST NOT be an image `ENV`. The App-update helper replays every entry of the previous container's `Config.Env` as `--env`, so an `ENV` identity from the old image would override the new image after every update. The release workflow passes the tag and source commit, including its explicit prerelease candidate build, to both App and Worker image builds. The local App image script can also receive explicit identity inputs. Worker images carry the same immutable identity file. [Worker Execution Environment Images](20260721-worker_execution_environment_images.md) and [Worker Control Protocol](20260703-worker_control_protocol.md) own Worker enforcement. Image tags and OCI labels remain publication identity. The same-tag reuse rule does not rewrite the identity file.

The app image may include Caddy as the current HTTP frontend.

Caddy is the current HTTP frontend, not a permanent product requirement. A future app image may replace Caddy if it preserves the same public HTTP boundary and smoke coverage. The current default public HTTP port is 8080. The current default loopback App listener port is 4317. The public NanoHost transport route returns 404. Unsupported API paths do not fall back to the Web UI.

### Worker Image Contract

`worker-common` is a published artifact but not a deployment image, so the contract below binds `worker-runtimes` and not the empty-set base. The base must instead carry the shared development environment and the generic shim package, contain exactly its empty declared runtime set, and remain buildable and smokeable on its own; `docs/specs/20260721-worker_execution_environment_images.md` owns those obligations and the extension guarantees a derived image may rely on. A release build that publishes the base without publishing it as a first-class catalog entry, or that treats it as deployable, is invalid.

Every release deployment worker image must:

- run inside OpenShell as a sandbox payload,
- provide the generic `openkit-worker-shim` entrypoint,
- include exactly its catalog-declared runtime set and the generic shim package whose existing static registry contains the AEP-selected adapter,
- provide every runtime binary id and worker-local executable path declared by its authored `AgentManifest`,
- provide `/openkit/sessions/<agent-session-id>/config/package.json`,
- write `/openkit/threads/<threadId>/<harness>/capture/<turnId>/events.jsonl`,
- write `/openkit/threads/<threadId>/<harness>/capture/<turnId>/items.jsonl`, where `<harness>` is the stable runtime adapter id, not a Harness Instance id,
- initialize the admitted work slot during `session.open` before starting its native runtime and expose its retained bytes to NanoHost outside-scan collection under [Workspace Synchronization](20260703-workspace_synchronization.md),
- expose a stable worker-visible workspace root,
- use the AEP snapshot as the source of worker-visible setup,
- keep runtime-native config generation inside worker packages,
- fail clearly when the required agent binary is missing.

Worker images must not discover or load adapters dynamically. The static registry contains four adapters, and `control.adapter.targetRuntime` selects one. The published catalog may grow through a reviewed specification and catalog change; that is not a fifth-image prohibition. Growth adds one image definition and one `containers/images.json` entry without adding another image registry, plugin loader, or runtime-specific NanoCore selector. Catalog field `runtimes`, OCI label `org.openkit.worker.runtimes`, and the CI, preflight, and label consumers change together in the same reviewed change.

Worker images must not:

- read NanoCore private storage directly,
- store vault secrets as durable image files,
- assume host filesystem paths,
- publish product API endpoints,
- advertise or execute an OpenKit-managed capability route or an OpenKit-managed integrated external system absent exact selected AEP supply and the separately authenticated governed Gateway path. Worker-configured in-Sandbox MCP is outside that supply plane and is not a packaging failure merely for lacking a catalog selection or Gateway hop. An exactly granted credential-free non-LLM public endpoint follows [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md#manifest-shape) and is not a packaging failure merely for lacking a Gateway hop; the rationale is recorded in [Public Endpoints By Admitted Grant](../decisions/20260930-public_endpoints_by_admitted_grant.md). Image contents confer no external authority,
- make final authorization decisions,
- treat image availability as external authority. Platform-managed external hosting calls use selected Gateway MCP and its current authorization, configured per-tool approval and audit. Local Git is worker-local work. Native Git push may be explicitly admitted user-space configuration; other external effects retain their own owners.
- treat OpenShell-native ids or logs as canonical product state.

### Worker Base Image Policy

This policy governs the upstream base that `worker-common` itself builds on. The deployment image `worker-runtimes` takes its base from `worker-common` rather than selecting an upstream base directly, so the rules below are satisfied once, at the base, and inherited. A deployment image that pins an upstream base of its own has bypassed the shared stage and is invalid.

Worker images must use a current digest-pinned upstream base that satisfies the exact OpenKit execution-environment contract. OpenShell Community sandbox images are the primary reference for useful developer tooling, non-root layout, and policy behavior, but an upstream image is not automatically a compliant OpenKit final image.

The base image must be digest-pinned before a release image is published.

The base image may use a tag during local development, but release builds must resolve and record the digest.

Updating the worker base digest is an explicit maintenance change. It must update `containers/images.json`, run worker image smoke checks, and run the real OpenShell worker verification for affected worker images.

OpenKit may use an upstream community sandbox image directly only when it contains the declared runtime set, the pinned OpenKit shim, the accepted tool and filesystem baseline, no baked authorization, and every other OpenKit worker invariant. The upstream community base combines multiple Agent runtimes and a broad baked policy, so OpenKit uses it as reference rather than as a final or inherited release image. OpenKit's deployment image `worker-runtimes` is a different artifact and does not inherit that baked policy.

### Release Artifact Boundary

A published image is a deployable projection of the Core and worker placement model. It makes placement reproducible; it owns nothing that Core owns.

Every published image, app or worker, MUST NOT contain durable product state, vault secret values, workspace truth, approval or review decisions, or final policy decisions. A digest-pinned base, build argument, label, entrypoint, or smoke script is a packaging fact and MUST NOT become the source of a product record.

`docs/core/architecture.md` owns the invariant that release artifacts do not change Core semantics. The packaging consequence is that building, publishing, retagging, or repinning an image MUST NOT redefine product records or their authorities; a packaging change that appears to require such a semantic change is a defect in the change, not a packaging option.

Every release artifact MUST be traceable to one source commit and one release tag through the tags and OCI labels defined by Version And Tag Policy and OCI Label Policy. Production-style deployments SHOULD reference an exact version or digest rather than a mutable convenience tag. Locally built artifacts and local development tags are build conveniences and are never release identity.

### Version And Tag Policy

Git tags are the release version source of truth.

Release tags must match:

```text
v<major>.<minor>.<patch>
```

Pre-release tags may match:

```text
v<major>.<minor>.<patch>-<pre>
```

Examples:

```text
v0.0.1
v0.0.2-rc.1
```

Published release images must receive:

- the exact Git tag, such as `v0.0.1`,
- the tag without the leading `v`, such as `0.0.1`,
- the source-revision tag, `sha-` plus the first 12 lowercase hexadecimal characters of the source commit.

Stable release images may also update `latest`.

Pre-release images must not update `latest`.

`latest` is a convenience tag for evaluation only.

Git branch names must not create release tags.

Pull request builds must not push release image tags.

### GHCR Publishing Policy

Release images publish to:

```text
ghcr.io/<github-owner>/<repository>
```

For example:

```text
ghcr.io/<github-owner>/openkit-app:v0.0.1
ghcr.io/<github-owner>/openkit-worker-runtimes:v0.0.1
```

The GitHub Actions workflow must authenticate to GHCR with `GITHUB_TOKEN` and `packages: write` permission. The workflow uses `github.repository_owner` by default. An explicit namespace override is allowed only for a manual workflow.

`worker-common` MUST be a public GHCR package that an end user can pull or derive from without registry credentials.

Publishing the public base grants no network, credential, filesystem, runtime-selection, or sandbox authority; those remain governed by the derived image's AgentManifest and runtime admission.

GitHub creates a newly published container package as private, so the first-publication owner MUST change `worker-common` visibility to public after the initial push and before rerunning the failed release job.

The publish job MUST remove its GHCR login and inspect the exact published `worker-common` digest anonymously before the release can pass.

OpenKit uses the registry digest namespace as the candidate boundary. It admits no separate promotion registry. OpenKit publishes only catalog-owned release entries. It does not retag or promote an image a user derives from `worker-common`. This specification admits no nightly product-image channel. A selected prerelease may still run candidate security diagnostics, and the internal test image may be a CI artifact. That is not a nightly product release.

The publish job must run only after release-gate jobs pass.

The publish job must build only manifest entries where `release` is `true`.

For a prerelease, the release workflow may build and smoke candidate images before the tag. Each platform build pushes only by digest. An assembled index may use a reference beginning with `candidate-` that cannot be mistaken for an exact-version, version-without-v, source-revision or Latest tag. No public release tag or Latest pointer moves before the real tag push. These candidates are not published releases or deployment inputs. Ordinary main validation remains valid when no intended prerelease is selected.

The candidate record binds the repository, intended prerelease tag, exact source commit P, workflow run and latest attempt, immutable build/smoke/index/promotion input identities, index digest, and exactly the catalog platform set and its digests. Each platform records successful smoke of that exact registry digest at P, matching OCI source repository, revision and version, and the App identity file when applicable. GitHub execution observations, not the record alone, prove run and attempt provenance. Changed candidate construction, smoke or index inputs are part of the publication-path proof and require the existing scratch rehearsal.

The tag job accepts only a complete candidate whose repository and intended tag match and whose recorded source revision equals the tagged commit. It promotes the recorded index digest unchanged, with exactly the recorded platform digests. It verifies the registry index-to-platform bindings, matching OCI source/revision/version and App identity observations, successful exact-P smoke, proved inputs and current run-attempt provenance before promotion. A changed P invalidates the old candidate even when its tree is identical. Missing, stale, partial, failed or inconsistent evidence refuses promotion; a fresh candidate run may supply new evidence, but a tag-stage rebuild cannot substitute for it. Before the tag, admission still proves unused release identities or the existing explicitly admitted immutable same-tag retry.

Release tags are assigned only after every required platform passed and the existing tag gates passed. All existing publication checks remain required: tag preflight and main membership, exact-P candidate admission, NanoHost qualification, immutable identity and retry, Latest invariants, anonymous Worker base inspection, GitHub Release consistency and downloaded assets. This prerelease candidate rule changes no stable publication rule or credential boundary.

The release workflow must derive mutable metadata from the release commit, serialize tag workflows, and reuse a complete same-tag identity only when its version, version-without-`v`, and source-revision tags resolve to the same digest.

A partial or conflicting existing tag identity must fail closed.

The publish job must emit a digest summary for every promoted or reused image.

The digest summary must be available as a GitHub Actions summary and should be copied into GitHub Release notes.

### OCI Label Policy

Published images must include OCI labels:

- `org.opencontainers.image.title`
- `org.opencontainers.image.description`
- `org.opencontainers.image.source`
- `org.opencontainers.image.revision`
- `org.opencontainers.image.version`
- `org.opencontainers.image.created`
- `org.opencontainers.image.licenses`
- `org.openkit.image.id`
- `org.openkit.image.kind`
- `org.openkit.worker.runtimes` for a deployment worker image, one label whose value is the catalog identifiers joined by commas in catalog order with no spaces
- `org.openkit.worker.contract` for a deployment worker image

The empty base omits runtime metadata, including `org.openkit.worker.runtimes` and `org.openkit.worker.contract`. Labels must not include secrets, local paths, private gateway names, or user-specific runtime data.

`org.opencontainers.image.created` must use the source commit timestamp so a same-tag rebuild is deterministic, and `org.opencontainers.image.licenses` must be `Apache-2.0` while the repository's current license remains in force.

### CI Gate Policy

The existing CI workflow remains the release gate owner.

Version tags must run:

- L0-L2 static, unit, and contract verification,
- L3 NanoCore e2e,
- L5 built-artifact smoke tests,
- image manifest validation,
- Dockerfile static tests,
- release image build,
- release image smoke,
- GHCR publish.

L4 Web browser e2e is required candidate admission under [Release Management](20260829-release_management.md#candidate-ci-and-tag-reuse). Deterministic L6 stories are not a pre-tag gate.

Release-tag promotion must not start if L0-L3, L4, or L5 fails. A pre-tag candidate upload creates no release identity and cannot bypass those gates.

Release tag promotion must not start if exact-digest image smoke fails.

### Local Script Policy

Local scripts should provide:

```bash
scripts/docker/build-image.sh app
scripts/docker/build-image.sh worker-runtimes
scripts/docker/smoke-image.sh app
scripts/docker/smoke-image.sh worker-runtimes
scripts/docker/run-app.sh
scripts/docker/e2e-app.sh
```

Scripts must read `containers/images.json`.

Scripts may default to local tags such as:

```text
openkit/app:dev
openkit/worker-runtimes:dev
```

Scripts must fail when an unknown image id is requested.

Scripts must not silently fall back to old root Dockerfile paths.

### Runtime Configuration Policy

Release docs must set worker image examples to `worker-runtimes`.

An authored deployment `AgentManifest` should select a release image such as:

```text
ghcr.io/<owner>/openkit-worker-runtimes:<version-or-digest>
```

A repository-owned manifest template may select this local development image:

```text
openkit/worker-runtimes:dev
```

Codex, OpenCode, Pi, and DeepSeek templates select that same image and differ by `targetRuntime`. The current templates select `openkit/worker-runtimes:dev`. Copy-on-init on a new data root is a first write of the accepted templates.

Every authored `AgentManifest` selects an OpenShell-compatible image reference that the NanoHost may pass to stock sandbox creation after admission; NanoCore copies that resolved reference into the AEP but performs no OpenShell lifecycle effect. A global `OPENKIT_OPENSHELL_WORKER_IMAGE` selector is not part of the current contract. Release manifests should use GHCR references or digests, while repository-owned local templates may use cataloged development tags.

### Supply Integrity

Image builds MUST use frozen installs and committed lock files or integrity hashes, including global CLI installs. Scripts MUST be disabled except for independently reviewed allowlisted packages. Every download MUST verify against a committed checksum; streamed installer execution is forbidden. Release image-platform SBOMs MUST be generated from the built artifacts, attached under checksums, and the App image MUST embed its SBOM for offline inventory. [Development Security](20261109-development_security.md) owns these controls and provenance requirements. A historical packaging check proves only the image bytes it ran. It is not evidence that a current runtime target is missing.

## Acceptance

The packaged App, restarted with the same mounted Data Root, retains and exposes the smoke-created Workspace and expected persisted data through its public interface.

## Implementation

- `containers/` — image catalog, Dockerfiles, entrypoints, and smoke scripts
- `scripts/docker/` — catalog-driven image build and smoke helpers
- `../../.github/workflows/` — release image build, smoke, and publish jobs

## Implementation Gaps

- Separate image signature policy - publication provenance is produced; a separate signature policy is not in force - #354
- Worker-consumer attestation verification - the producer checks publication subjects; Worker-consumer enforcement is not in force - #691

## Decisions

- [Earlier-version data is not carried](../decisions/20260930-earlier_version_data_not_carried.md)
- [Pi native MCP discovery](../decisions/20260930-pi_native_mcp_discovery.md)
- [Public endpoints by admitted grant](../decisions/20260930-public_endpoints_by_admitted_grant.md)
