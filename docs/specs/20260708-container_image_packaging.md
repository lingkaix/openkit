---
status: Accepted
implementation: Partial
---
# Container Image Packaging And Release Publishing

## Owns

- The canonical OpenKit container image taxonomy.
- The repository layout for Dockerfiles, image smoke scripts, and image metadata.
- The machine-readable image manifest used by local scripts and GitHub Actions.
- The release tag to GHCR publishing contract for OpenKit-owned images.
- The version, tag, label, digest, and provenance rules for published images.
- The boundary between a published release artifact and Core product truth, including what an image may never contain and what publishing an image may never change.
- The migration path away from root-level Dockerfiles and staging-specific script names.

## Does Not Own

- NanoCore runtime semantics, which are owned by `docs/core/runtime-model.md`.
- Sandbox semantics and backend-private containment details, which are owned by `docs/core/sandbox.md`.
- Worker-facing control, capability, inference, data, and evidence protocols, which are owned by `docs/specs/20260629-worker_runtime_communication_model.md`, `docs/specs/20260703-worker_control_protocol.md`, and `docs/specs/20260703-worker_agent_capability.md`.
- Agent Environment Package field semantics, which are owned by `docs/specs/20260616-agent_environment_package.md`.
- OpenShell provider, policy, vault, and evidence internalization, which is owned by `docs/specs/20260703-openshell_mechanism_internalization.md`.
- Runtime Epoch lifecycle, Sandbox Integration, RelayStream, route credentials, and runtime transport, which are owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`.
- Kubernetes, Helm, Docker Compose, installer, desktop-app, or platform-specific deployment packaging.
- npm package publishing, language package versioning, or third-party marketplace distribution.
- Product-wide release composition, authorization, retry, and completion semantics, which are owned by `docs/specs/20260829-release_management.md`.

## Core References

- `docs/core/architecture.md`
- `docs/core/runtime-model.md`
- `docs/core/sandbox.md`
- `docs/core/agent-supply.md`
- `docs/core/agent-capability.md`
- `docs/core/vault.md`
- `docs/core/audit.md`

## Related Docs

- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260703-openshell_mechanism_internalization.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/specs/20260829-release_management.md`

## Summary

OpenKit needs one explicit container packaging contract because product runtime, worker runtime, staging validation, and release publishing are currently spread across root Dockerfiles, Docker cookbooks, shell scripts, runtime docs, and GitHub Actions.

The clean target is:

```text
containers/
  README.md
  images.json
  app/
    Dockerfile
    entrypoint.sh
    smoke.sh
  worker-codex/
    Dockerfile
    smoke.sh
  worker-opencode/
    Dockerfile
    smoke.sh
  worker-pi/
    Dockerfile
    smoke.sh
  test-env/
    Dockerfile
    smoke.sh
scripts/docker/
  build-image.sh
  run-app.sh
  smoke-image.sh
  e2e-app.sh
.github/workflows/
  ci.yml
```

`containers/images.json` is the source of truth for OpenKit-owned images. Git tags such as `v0.0.1` are the source of truth for release versions. GitHub Actions publishes release images to GitHub Container Registry only after the existing release gate passes.

## Goals / Non-goals

Goals:

1. Separate the app image from worker images.
2. Define which images are release artifacts and which images are local development tools.
3. Make `containers/images.json` the only machine-readable image catalog.
4. Publish release images to GHCR from version tags.
5. Keep GHCR image tags, OCI labels, and GitHub release notes traceable to one Git commit and one Git tag.
6. Use upstream OpenShell Community sandbox images as a reviewed environment and policy reference while keeping the OpenKit worker base digest-pinned and contract-specific.
7. Keep OpenKit worker contracts inside OpenKit-owned worker shims.
8. Remove staging-specific names from future release packaging.
9. Make image smoke checks mandatory before publishing.
10. Keep the design small enough to implement without a custom release platform.

Non-goals:

- Do not publish `test-env` by default on product release tags.
- Do not make OpenShell gateway state, OpenShell policy YAML, or OpenShell provider records canonical OpenKit release artifacts.
- Do not introduce Docker Compose, Helm, Kubernetes, or desktop-app packaging in this spec.
- Do not support repository-owned backward compatibility for old Dockerfile paths after the migration lands.
- Do not make `latest` the recommended production deployment reference.

## Background

Before this spec was implemented, the repository had three active Dockerfiles spread across root-level paths:

- `Dockerfile.staging` builds a single-container staging image with NanoCore, Web UI assets, Caddy, Codex, OpenCode, and runtime smoke support.
- `Dockerfile.openshell-worker` builds the first OpenKit-owned OpenShell worker image with `packages/worker-protocol`, `packages/worker-shim`, Codex, session directories, and worker entrypoints.
- `Dockerfile.dev-e2e` builds a debug and browser/e2e validation image.

The repository also had `scripts/docker/staging-*` helpers and Docker cookbooks under `docs/cookbooks/`. Those files encoded useful implementation details, but the naming treated staging as the central packaging concept.

The active worker runtime design has moved to governed container workers. Host execution is not a real Worker Agent product runtime. The first serious worker backend is OpenShell, and the worker-facing contract requires the generic `openkit-worker-shim` plus a static adapter registry; `control.adapter.targetRuntime` selects exactly one adapter per session. Image contents confer no adapter authority. Runtime-specific shim entrypoints and a separate sidecar are not part of the design.

The historical `docs/specs/superseded/20260518-staging_docker_distribution.md` is not current guidance. It remains useful background for why the staging image exists, but it still carries host-mode and loopback-agent assumptions that must not shape the new release packaging contract.

Before this spec was applied, `.github/workflows/ci.yml` already ran release-gate jobs when version tags matching `v*.*.*` or `V*.*.*` were pushed. It did not publish images to GHCR.

## Decision

OpenKit will use one catalog-driven image packaging model.

The repository-owned image classes are:

| Image id | Release artifact | Purpose | Base image rule |
| --- | --- | --- | --- |
| `app` | Yes | Product app image containing NanoCore, Web UI, public HTTP entrypoint, migrations, and data templates. | Use the digest-pinned Node runtime base declared in the image catalog and matching repository Node policy. |
| `worker-common` | Yes | Published public extension base carrying the shared development environment and worker shim, with an empty declared runtime set. It is the extension point for the current deployment leaves and for user or secondary-developer sandbox images. It is not the `test-env` base. | Use the pinned digest-addressed upstream base under Worker Base Image Policy. |
| `worker-codex` | Yes | OpenShell sandbox payload for Codex worker execution through OpenKit worker shim. Current leaf whose catalog-declared runtime set is Codex only. | Use the pinned shared OpenKit development stage and add only the Codex runtime leaf. |
| `worker-opencode` | Yes | OpenShell sandbox payload for OpenCode worker execution through OpenKit worker shim. Current leaf whose catalog-declared runtime set is OpenCode only. | Use the pinned shared OpenKit development stage and add only the OpenCode runtime leaf. |
| `worker-pi` | Yes | OpenShell sandbox payload for Pi worker execution through OpenKit worker shim. Current leaf whose catalog-declared runtime set is Pi only. | Use the pinned shared OpenKit development stage and add only the Pi runtime leaf. |
| `test-env` | Never on a release tag; published for CI to consume | Internal sibling of `worker-common`, owned by `docs/toolchain.md` Test Execution Environment. Pins the same upstream Node digest independently and does not derive `FROM worker-common`. | Use the same digest-pinned Node base as the worker common stage and install only what the gates execute; no worker runtime. |

App image and worker images MUST remain separate release units. The one allowed exception is a single-machine evaluation bundle that an explicit deployment owns and names; a normal release build MUST NOT merge the app and worker units, and the app image MUST NOT bundle worker agent runtimes as its release model.

The app image is user-facing. It owns NanoCore startup, Web UI static assets, public HTTP routing, data-root layout, database migrations, app smoke checks, and packaged UI checks.

Worker images are backend payloads. They own agent runtime binaries, the generic OpenKit worker shim package, worker-visible `/openkit` layout, transcript output paths, runtime-native config materialization, and the manifest-selected adapter projection. They do not own product state, review decisions, workspace truth, vault truth, or public API semantics.

## Contract / Expected Behavior

### Image Manifest

The repository must define `containers/images.json`.

The manifest must be valid JSON and must include:

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
      "baseImage": "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d",
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

Every release image entry must also include `baseImage`, a digest-pinned direct base reference.

`anonymousPull` is an optional boolean publication predicate; exactly one public release worker base sets it to `true`, and every other entry omits it or sets it to `false`.

Deployment worker image entries must also include:

- `runtime`: a non-empty string containing singular descriptive catalog metadata for a current leaf, such as `codex`, `opencode`, or `pi`. Omit this field when the declared runtime set is empty. Do not add a `runtimes` array until the first published multi-runtime artifact migrates this metadata together with CI, preflight, and OCI-label consumers.
- `workerContract`: a non-empty string containing the OpenKit worker contract version, initially `openkit-worker-v1`. Required exactly when runtime metadata exists, and forbidden when it does not.
- `target`: unique shared-Dockerfile build target.

A public release worker base is identified structurally by absent `runtime` and explicit `anonymousPull: true`, not by a reserved image id. That entry must include `baseImage` and `target`, must omit `runtime` and `workerContract`, and remains `kind: worker` so the existing catalog and release path can build, smoke, publish, and verify it without a parallel image class. The current such entry is `worker-common`. Release preflight must require exactly one such release worker base and must not special-case an image id.

The authored `AgentManifest`, not this packaging catalog or a backend-global environment variable, selects the governed image reference and declares the runtime binary ids and absolute worker-local executable paths. NanoCore resolves that declaration into the AEP without a runtime-specific image branch. `control.adapter.targetRuntime` selects exactly one adapter per session. The image entry records how the selected artifact is built, smoked, and published; it is not a second runtime selector, and image contents confer no authority.

The manifest may include optional build args, labels, target names, or publish policy fields when those fields are consumed by scripts and tested.

The manifest must not include secrets, tokens, private registry credentials, local absolute paths, or user-specific image names.

### Repository Layout

OpenKit-owned image Dockerfiles must live beneath `containers/`. An independently implemented image uses `containers/<image-id>/Dockerfile`; the four worker artifacts use the shared `containers/workers/Dockerfile` plus unique manifest targets owned by `docs/specs/20260721-worker_execution_environment_images.md`. An OpenKit-owned image that derives from a published OpenKit base is an independently implemented image and keeps its own directory and Dockerfile; deriving does not move it into the base's shared Dockerfile.

Each image directory must include a `README.md` when the image has operator-visible behavior beyond `docker build`.

Each release image directory must include a smoke script.

Root-level Dockerfiles are migration-only and must be removed after their image directories are live.

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

The app image may include Caddy as the current HTTP frontend.

Caddy is an implementation projection, not a permanent product requirement. A future app image may replace Caddy if it preserves the same public HTTP boundary and smoke coverage.

### Worker Image Contract

`worker-common` is a published artifact but not a deployment image, so the contract below binds current deployment leaves and not the empty-set base. The base must instead carry the shared development environment and the generic shim package, contain exactly its empty declared runtime set, and remain buildable and smokeable on its own; `docs/specs/20260721-worker_execution_environment_images.md` owns those obligations and the extension guarantees a derived image may rely on. A release build that publishes the base without publishing it as a first-class catalog entry, or that treats it as deployable, is invalid.

Every release deployment worker image must:

- run inside OpenShell as a sandbox payload,
- provide the generic `openkit-worker-shim` entrypoint,
- include exactly its catalog-declared runtime set and the generic shim package whose existing static registry contains the AEP-selected adapter,
- provide every runtime binary id and worker-local executable path declared by its authored `AgentManifest`,
- provide `/openkit/config/package.json`,
- write `/openkit/session/events.jsonl`,
- write `/openkit/session/items.jsonl`,
- write `/openkit/session/artifacts.jsonl`,
- write `/openkit/session/workspace-changes.json` when workspace changes exist,
- expose a stable worker-visible workspace root,
- use the AEP snapshot as the source of worker-visible setup,
- keep runtime-native config generation inside worker packages,
- fail clearly when the required agent binary is missing.

Worker images must not discover or load adapters dynamically. The published catalog may grow through a reviewed specification and catalog change; that is not a fifth-image prohibition. A new singular leaf still adds one image definition and one `containers/images.json` entry without adding another image registry, plugin loader, or runtime-specific NanoCore selector. The first published multi-runtime artifact must migrate singular `runtime` metadata and its CI, preflight, and OCI-label consumers in the same reviewed change.

Worker images must not:

- read NanoCore private storage directly,
- store vault secrets as durable image files,
- assume host filesystem paths,
- publish product API endpoints,
- advertise or execute a worker capability or MCP route absent exact selected AEP supply and the separately authenticated governed Gateway path,
- make final authorization decisions,
- push, tag, deploy, or mutate protected branches without NanoCore-approved review and apply gates,
- treat OpenShell-native ids or logs as canonical product state.

### Worker Base Image Policy

This policy governs the upstream base that `worker-common` itself builds on. The three deployment images take their base from `worker-common` rather than selecting an upstream base directly, so the rules below are satisfied once, at the base, and inherited. A deployment image that pins an upstream base of its own has bypassed the shared stage and is invalid.

Worker images must use a current digest-pinned upstream base that satisfies the exact OpenKit execution-environment contract. OpenShell Community sandbox images are the primary reference for useful developer tooling, non-root layout, and policy behavior, but an upstream image is not automatically a compliant OpenKit final image.

The base image must be digest-pinned before a release image is published.

The base image may use a tag during local development, but release builds must resolve and record the digest.

Updating the worker base digest is an explicit maintenance change. It must update `containers/images.json`, run worker image smoke checks, and run the real OpenShell worker verification for affected worker images.

OpenKit may use an upstream community sandbox image directly only when it contains the declared runtime set, the pinned OpenKit shim, the accepted tool and filesystem baseline, no baked authorization, and every other OpenKit worker invariant. The current upstream base combines multiple Agent runtimes and a broad baked policy, so OpenKit uses it as reference rather than as a final or inherited release image.

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
- the source revision tag, such as `sha-<shortsha>`.

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
ghcr.io/<github-owner>/openkit-worker-codex:v0.0.1
```

The GitHub Actions workflow must authenticate to GHCR with `GITHUB_TOKEN` and `packages: write` permission.

`worker-common` MUST be a public GHCR package that an end user can pull or derive from without registry credentials.

Publishing the public base grants no network, credential, filesystem, runtime-selection, or sandbox authority; those remain governed by the derived image's AgentManifest and runtime admission.

GitHub creates a newly published container package as private, so the first-publication owner MUST change `worker-common` visibility to public after the initial push and before rerunning the failed release job.

The publish job MUST remove its GHCR login and inspect the exact published `worker-common` digest anonymously before the release can pass.

The publish job must run only after release-gate jobs pass.

The publish job must build only manifest entries where `release` is `true`.

The publish job must push one digest-only candidate, smoke that exact digest on every cataloged platform, and assign release tags only after every platform passes.

The publish job must derive mutable metadata from the release commit, serialize tag workflows, and reuse a complete same-tag identity only when its version, version-without-`v`, and source-revision tags resolve to the same digest.

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
- `org.openkit.worker.runtime` for worker images
- `org.openkit.worker.contract` for worker images

Labels must not include secrets, local paths, private gateway names, or user-specific runtime data.

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

L4 Web browser e2e and deterministic L6 stories remain manual unless the testing strategy spec promotes them into the automatic release gate.

Image publishing must not start if L0-L3 or L5 fails.

Release tag promotion must not start if exact-digest image smoke fails.

### Local Script Policy

Local scripts should provide:

```bash
scripts/docker/build-image.sh app
scripts/docker/build-image.sh worker-codex
scripts/docker/smoke-image.sh app
scripts/docker/smoke-image.sh worker-codex
scripts/docker/run-app.sh
scripts/docker/e2e-app.sh
```

Scripts must read `containers/images.json`.

Scripts may default to local tags such as:

```text
openkit/app:dev
openkit/worker-codex:dev
```

Scripts must fail when an unknown image id is requested.

Scripts must not silently fall back to old root Dockerfile paths.

### Runtime Configuration Policy

Release docs must set worker image examples to the new repository names.

The Codex `AgentManifest` should select a release image such as:

```text
ghcr.io/<owner>/openkit-worker-codex:<version-or-digest>
```

The repository-owned Codex manifest template may select this local development image:

```text
openkit/worker-codex:dev
```

Every authored `AgentManifest` selects an OpenShell-compatible image reference that the NanoHost may pass to stock sandbox creation after admission; NanoCore copies that resolved reference into the AEP but performs no OpenShell lifecycle effect. A global `OPENKIT_OPENSHELL_WORKER_IMAGE` selector is not part of the current contract. Release manifests should use GHCR references or digests, while repository-owned local templates may use cataloged development tags.

## Proposed Design

### Directory Layout

The target layout is:

```text
containers/
  README.md
  images.json
  app/
    README.md
    Dockerfile
    entrypoint.sh
    smoke.sh
  workers/
    README.md
    Dockerfile
    openkit-worker-shim
  worker-codex/
    README.md
    smoke.sh
  worker-opencode/
    README.md
    smoke.sh
  worker-pi/
    README.md
    smoke.sh
  test-env/
    README.md
    Dockerfile
    smoke.sh
scripts/docker/
  build-image.sh
  run-app.sh
  smoke-image.sh
  e2e-app.sh
```

The shared worker Dockerfile exposes `worker-codex`, `worker-opencode`, and `worker-pi` final targets. The three runtime directories retain their smoke scripts and operator-visible ownership without duplicating Dockerfiles.

The initial migration should create only directories for live images.

### Initial Manifest

The initial manifest should include:

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
      "platforms": ["linux/amd64", "linux/arm64"],
      "smoke": "containers/app/smoke.sh",
      "smokeCommand": "openkit-app-smoke",
      "localTag": "openkit/app:dev"
    },
    {
      "id": "worker-codex",
      "repository": "openkit-worker-codex",
      "dockerfile": "containers/workers/Dockerfile",
      "target": "worker-codex",
      "context": ".",
      "kind": "worker",
      "runtime": "codex",
      "release": true,
      "workerContract": "openkit-worker-v1",
      "baseImage": "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d",
      "platforms": ["linux/amd64", "linux/arm64"],
      "smoke": "containers/worker-codex/smoke.sh",
      "smokeCommand": "openkit-worker-codex-smoke",
      "localTag": "openkit/worker-codex:dev"
    },
    {
      "id": "test-env",
      "repository": "openkit-test-env",
      "dockerfile": "containers/test-env/Dockerfile",
      "context": ".",
      "kind": "test",
      "release": false,
      "platforms": ["linux/amd64"],
      "smoke": "containers/test-env/smoke.sh",
      "smokeCommand": "openkit-test-env-smoke",
      "localTag": "openkit/test-env:dev"
    }
  ]
}
```

The first layout migration retained the existing Node base. The accepted 2026-07-21 environment refresh now uses the current digest-pinned Node 24 LTS base and the internal common-stage contract in `docs/specs/20260721-worker_execution_environment_images.md`; the upstream OpenShell Community base remains a reference rather than a release parent.

### GitHub Actions Shape

The existing `CI` workflow should keep release-gate jobs split by test layer.

The image publish path is catalog-driven:

```text
image-matrix
  -> validates containers/images.json
  -> emits release image matrix

publish-images
  -> needs L0-L2, L3, L5, and image-matrix
  -> pushes each multi-platform image as a digest-only candidate
  -> smokes the same digest on every declared platform
  -> promotes that digest to release tags
  -> emits digest summary
```

The workflow should avoid hand-maintained image lists. Image matrix generation should read `containers/images.json`.

The workflow may use standard Docker GitHub Actions, but their major versions are implementation details that should be pinned when the workflow is edited.

### Tag Derivation

For stable `v0.0.1`, each release image gets:

```text
ghcr.io/<owner>/openkit-app:v0.0.1
ghcr.io/<owner>/openkit-app:0.0.1
ghcr.io/<owner>/openkit-app:sha-<shortsha>
ghcr.io/<owner>/openkit-app:latest
```

For pre-release `v0.0.2-rc.1`, each release image gets:

```text
ghcr.io/<owner>/openkit-app:v0.0.2-rc.1
ghcr.io/<owner>/openkit-app:0.0.2-rc.1
ghcr.io/<owner>/openkit-app:sha-<shortsha>
```

Pre-release tags do not update `latest`.

### Image Promotion

OpenKit uses GHCR's digest namespace as the temporary candidate boundary and does not need a separate promotion registry.

The release tag build pushes an untagged digest, and `docker buildx imagetools create` assigns release tags only after that exact digest passes every platform smoke check.

Same-tag reruns reuse a complete, matching immutable identity and build only absent image identities.

## Current Implementation

Applied image catalog and Dockerfile layout:

- `containers/images.json`
- `containers/app/Dockerfile`
- `containers/workers/Dockerfile`
- `containers/workers/openkit-worker-shim`
- `containers/workers/smoke-common.sh`
- `containers/test-env/Dockerfile`
- `containers/app/entrypoint.sh`
- `containers/app/smoke.sh`
- `containers/worker-codex/smoke.sh`
- `containers/worker-opencode/smoke.sh`
- `containers/worker-pi/smoke.sh`
- `containers/test-env/smoke.sh`

Applied Docker helper scripts:

- `scripts/docker/build-image.sh`
- `scripts/docker/smoke-image.sh`
- `scripts/docker/run-app.sh`
- `scripts/docker/app-persistence-smoke.sh`
- `scripts/docker/e2e-app.sh`

Updated tests that enforce the manifest and Dockerfile paths:

- `apps/nanocore/src/docker/container-images-manifest.test.ts`
- `apps/nanocore/src/docker/app-dockerfile.test.ts`
- `apps/nanocore/src/docker/openshell-worker-dockerfile.test.ts`
- `apps/nanocore/src/docker/app-run-script.test.ts`
- `apps/nanocore/src/docker/app-persistence-smoke.test.ts`

Runtime documentation updated with the new worker image name:

- `docs/manual/nanocore-deployment-modes.en.md`
- `apps/nanocore/README.md`

Release workflow state:

- `.github/workflows/ci.yml` runs on version tags and manual dispatch.
- Version tags run the release gate through L0-L3 and L5.
- After the release gate passes, the workflow pushes, smokes, and promotes `release: true` images from `containers/images.json`, then verifies every published digest.
- The workflow packages the complete end-user Skill, creates an immutable GitHub Release, and runs the product-wide completion predicates owned by `docs/specs/20260829-release_management.md`.

Runtime default state:

- Repository-owned `AgentManifest` templates select their exact cataloged worker image, runtime adapter, binary paths, pull policy, provider route, credential requirements, and sandbox policy.
- NanoCore resolves the manifest into the AEP generically. It has no runtime-specific image selector, native command schema, or global worker-image fallback.
- The AEP launches `openkit-worker-shim`; `control.adapter.targetRuntime` selects one adapter in the shim's static registry.
- Current release documentation uses exact GHCR version or digest references.

The current catalog contains separate Codex, OpenCode, and Pi worker images. Each currently contains the generic shim and a singular catalog-declared runtime: Codex `0.144.1`, OpenCode `1.18.1`, or Pi `0.80.7`. Those leaves remain singular facts because no present need merges them.

Release worker base state:

- `containers/images.json` pins every current release `baseImage` value to `node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` and selects one unique target per worker artifact.
- Both app Dockerfile stages use that exact cataloged digest.
- `containers/workers/Dockerfile` uses that digest-pinned Node base for the shared shim-builder and common stages, then adds exactly the catalog-declared runtime set in each final target.
- `test-env` is an internal sibling that pins the same Node digest in its own Dockerfile and does not derive `FROM worker-common`. After first `worker-common` GHCR publication, one internal `release: false` `kind: test` dogfood image may derive that published digest with Codex plus Pi and without OpenCode; that image is design and backlog only here.

Worker runtime state:

- The generic shim uses one static registry and the bounded `prepare`/`collect` contract. Native runtime schemas and commands remain outside NanoCore and canonical worker schemas.
- The Codex launcher preserves the OpenShell-provided proxy variables and enables Node environment-proxy support with `NODE_USE_ENV_PROXY=1` so Node `fetch` follows the governed egress path.
- The deleted Cell launcher preserved inherited `NO_PROXY` and `no_proxy` entries but did not add `host.openshell.internal`; its authenticated NanoCore worker-control origin remained reachable through the OpenShell policy proxy. The current path uses Sandbox Integration and distinct `/worker-control/*`, `/inference/*`, and `/capabilities/*` bindings over the NanoHost-owned transport.
- The image and launcher MUST provide a writable runtime home through `CODEX_HOME` or `HOME` before the optional S33 Codex provenance extension starts. Missing home state is a Codex image or provenance failure, not a shared adapter-contract requirement, and MUST fail closed before inference when that extension is required.

A1 verification state before the 2026-07-21 execution-environment refresh:

- The previous three minimal arm64 worker images were built directly on A1 and passed their image smoke checks.
- Historical stock unpatched OpenShell `0.0.80` evidence created one sandbox from each previous image, uploaded its AEP package, completed the generic shim dry run, and deleted the sandbox after the Cell's separate same-tag image cache was refreshed.
- This historical evidence proves the unchanged adapter, shim, stock OpenShell containment, upload, and cleanup path for the previous image contents only. It is not current verification of the refreshed common environment or its new AEP network grants.

Current refreshed-image verification state:

- On 2026-07-21, all three refreshed arm64 final targets built from `containers/workers/Dockerfile` on the current development host and passed their complete image smoke checks as non-root `sandbox` users.
- The same host cross-built all three refreshed targets as `linux/amd64`, and every cross-platform image passed the same complete non-root smoke contract.
- On 2026-08-01, historical A1 verification repeated stock OpenShell create, AEP upload, shim dry-run, and legacy whole-Cell cleanup for every refreshed image. This proves image compatibility only; it does not prove the unimplemented Runtime Epoch target, stock RelayStream plus nested standard HTTP/2 feasibility, or route-token separation.

## Alternatives Considered

### Keep Root Dockerfiles

Rejected. Root-level Dockerfiles are easy to discover initially, but they do not scale once app, worker, dev, CI, and release policy need separate ownership.

### Keep Staging As The Main Image Concept

Rejected. Staging is a validation and dogfooding mode, not the formal product packaging model. Keeping staging as the central name would preserve old host-mode assumptions and make release docs harder to reason about.

### Publish One Universal Worker Image

Not a ban. A universal worker image would couple unrelated runtime releases onto one artifact and enlarge the supply surface every consumer inherits. Those costs are why the current leaves stay separate, not a platform prohibition on a later reviewed multi-runtime artifact.

### Publish An OpenKit Worker Base — Superseded 2026-08-12

Originally rejected. The measured duplication justified one internal common Docker stage, but no manifest, deployment, or user selected a common artifact, so publishing a fourth image would have added release and compatibility surface without a current consumer.

Superseded because users and secondary developers now select the public extension base. The release and compatibility surface named above is accepted rather than disputed, and `docs/specs/20260721-worker_execution_environment_images.md` owns what that obliges. The repository `test-env` image is a sibling, not a derivation consumer of that published digest. The alternative that stays rejected is publishing a base with no consumer.

### Publish Images On Every Main Push

Rejected. The current workflow policy is intentionally resource-light, and release publishing should stay tied to explicit version tags. Main-branch images can be added later as a manual or nightly diagnostic feature if needed.

### Use Package Version As Image Version

Rejected. The monorepo root package currently uses `0.0.0`, and OpenKit release artifacts are product-level release bundles. Git tags are a simpler and more accurate release source of truth.

## Consequences

- Release artifacts become discoverable through GHCR with stable version tags.
- Users can pull `ghcr.io/<owner>/openkit-app:v0.0.1` and matching worker images.
- Deployment docs can recommend digest-pinned images without inventing a separate artifact registry.
- CI gets a clear publish gate that composes with existing release tests.
- The repository loses some root-level convenience, but gains one image catalog and one directory boundary.
- OpenShell remains a backend mechanism and base image source, not the owner of OpenKit product semantics.

## Rollout / Migration Plan

1. Add this spec.
2. Add `containers/images.json` with current live images.
3. Keep runtime-specific worker smoke and operator notes in their leaf directories while building all three final worker artifacts from `containers/workers/Dockerfile` with unique targets.
4. Move `Dockerfile.dev-e2e` to `containers/dev-e2e/Dockerfile` without behavior changes. That directory was later renamed to `containers/test-env`; see `docs/toolchain.md` Test Execution Environment.
5. Move `Dockerfile.staging` to `containers/app/Dockerfile` and rename staging-specific entrypoint and smoke scripts to app-image names.
6. Add `scripts/docker/build-image.sh` and `scripts/docker/smoke-image.sh` as manifest-driven wrappers.
7. Rename `scripts/docker/stage.sh` to `scripts/docker/run-app.sh` or keep a temporary same-change redirect only until all docs and package scripts are updated in the same PR.
8. Update Dockerfile static tests to use `containers/images.json`.
9. Update `docs/cookbooks/` to point at the new app and dev/e2e image docs, or retire the old cookbook pages after their content moves into `containers/*/README.md`.
10. Move worker image and runtime binary selection from the global NanoCore default into each authored `AgentManifest` and its resolved AEP.
11. Update deployment docs to use GHCR release image examples.
12. Add GHCR publish jobs to `.github/workflows/ci.yml` or a dedicated image workflow that is triggered by the same release tags and depends on the existing release gate.
13. After the migration is complete, remove root-level Dockerfiles and stale staging-specific script names.

Because OpenKit is in active internal development, no permanent compatibility aliases are required for old Dockerfile paths, old image names, or old staging script names.

## Testing Strategy / Acceptance Criteria

Manifest validation:

- `containers/images.json` parses as JSON.
- Every `dockerfile`, `context`, and `smoke` path exists.
- Every `id` is unique.
- Every release image has at least one platform.
- Every deployment worker image has `runtime`, `baseImage`, `workerContract`, and a unique `target` consumed by local build scripts and release CI.
- A release worker base is identified by absent `runtime` and explicit `anonymousPull: true`, has `baseImage` and a unique `target`, and has neither `runtime` nor `workerContract`. `workerContract` is required exactly when runtime metadata exists.
- Every release image has a digest-pinned `baseImage`.
- No manifest field contains an absolute local path.

Dockerfile static tests:

- App image Dockerfile builds NanoCore and Web dependencies in dependency order.
- App image Dockerfile copies required migrations, data templates, app entrypoint, and app smoke script.
- The shared worker Dockerfile uses digest-pinned direct image inputs, builds `@openkit/worker-protocol` and `@openkit/worker-shim` once, and exposes one final target per release worker.
- Every final worker target installs exactly its catalog-declared runtime set and verified binary paths.
- The shared worker stage creates `/openkit/config`, `/openkit/session`, and `/openkit/artifacts` and declares the sandbox user expected by OpenShell.
- Codex image and launcher tests separately require a writable runtime home and the governed Node proxy contract when the optional S33 provenance extension is enabled.

Local build acceptance:

- `scripts/docker/build-image.sh app` builds `openkit/app:dev`.
- `scripts/docker/build-image.sh worker-common` builds `openkit/worker-common:dev`.
- `scripts/docker/build-image.sh worker-codex` builds `openkit/worker-codex:dev`.
- `scripts/docker/build-image.sh worker-opencode` builds `openkit/worker-opencode:dev`.
- `scripts/docker/build-image.sh worker-pi` builds `openkit/worker-pi:dev`.
- `scripts/docker/smoke-image.sh app` passes.
- `scripts/docker/smoke-image.sh worker-common` passes, including the throwaway derived-image proof.
- `scripts/docker/smoke-image.sh worker-codex` passes.
- `scripts/docker/smoke-image.sh worker-opencode` passes.
- `scripts/docker/smoke-image.sh worker-pi` passes.

App image smoke acceptance:

- The container boots.
- `/api/health` responds through the public HTTP port.
- The Web UI root responds through the public HTTP port.
- A mounted `/data/openkit` persists expected smoke data across restart.

Worker image smoke acceptance:

- The image contains the generic `openkit-worker-shim` and proves that its manifest-selected adapter exists in the static registry.
- The image contains every native runtime binary and worker-local executable path declared by its authored `AgentManifest`.
- The image can read an AEP package from `/openkit/config/package.json`.
- The image can write session records under `/openkit/session`.
- The image runs the native runtime's bounded machine-readable mode without advertising worker capability or executable MCP routes.
- The Codex image exposes a writable `CODEX_HOME` or `HOME` when the optional S33 provenance extension is enabled; this is not a shared worker-image requirement.

OpenShell acceptance:

- Each release worker image must remain compatible with stock `openshell sandbox create --from` as an isolated packaging check.
- The packaging check for each release worker image must prove stock OpenShell sandbox creation, AEP upload, generic shim dry run, and sandbox deletion without becoming a selectable product lifecycle path.
- That packaging check does not prove a real-provider turn, NanoHost lifecycle, RelayStream, nested HTTP/2, route-token separation, or worker-control behavior. Applicable release-candidate provider and worker stories must execute and pass under their owning specifications; a skipped story does not satisfy that separate release gate.

CI acceptance:

- Pull requests do not push images.
- Version tags run the release gate.
- GHCR publish runs only after the release gate passes.
- The exact published `worker-common` digest is anonymously pullable after the publish job removes its registry login.
- Published image digests are emitted in the workflow summary.
- Pre-release tags do not update `latest`.
- Stable version tags update `latest`.

## Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| Upstream OpenShell base changes break workers. | Pin base image digests and treat digest updates as explicit maintenance changes. |
| Multi-arch builds fail because one runtime binary is unavailable. | Keep `platforms` per image in `containers/images.json` and publish only tested platforms. |
| `latest` causes accidental upgrades. | Apply the exact-version-or-digest deployment reference rule in the Release Artifact Boundary. |
| Image publishing happens before tests pass. | Make publish jobs depend on release-gate jobs and image smoke jobs. |
| Staging vocabulary keeps leaking into release docs. | Rename image ids, script names, and docs during migration, and do not keep old names as permanent aliases. |
| Worker image grows into a second product runtime. | Keep worker image responsibilities limited to runtime adaptation and OpenKit worker records. |
| GHCR package namespace differs across forks. | Use `github.repository_owner` by default and allow explicit namespace override only for manual workflows. |
| GitHub creates the first `worker-common` package as private. | Make the package public once after the first push, then rerun the failed release job whose logged-out exact-digest inspection decides anonymous usability. |

## Open Questions

- None.

## Deferred / Future Work

- Signed images and signature verification policy.
- SBOM generation and vulnerability scanning as release blockers.
- Build provenance attestations as a required release artifact.
- Nightly or main-branch diagnostic image publishing.
- Kubernetes, Helm, or Compose packaging.
- Desktop app packaging with bundled or external NanoCore.
- Retagging or promoting a derived image built by a user from the published `worker-common` base; a derivation is the user's artifact and OpenKit publishes only its own catalog entries.

## Links

- `docs/change-execution.md`
- `docs/specs/README.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260721-worker_execution_environment_images.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260703-openshell_mechanism_internalization.md`
- `docs/specs/superseded/20260518-staging_docker_distribution.md`
- `docs/manual/nanocore-deployment-modes.en.md`
- `.github/workflows/ci.yml`
