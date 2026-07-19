# Container Image Packaging And Release Publishing

Status: Accepted
Implementation: Partial

## Owns

- The canonical OpenKit container image taxonomy.
- The repository layout for Dockerfiles, image smoke scripts, and image metadata.
- The machine-readable image manifest used by local scripts and GitHub Actions.
- The release tag to GHCR publishing contract for OpenKit-owned images.
- The version, tag, label, digest, and provenance rules for published images.
- The migration path away from root-level Dockerfiles and staging-specific script names.

## Does Not Own

- NanoCore runtime semantics, which are owned by `docs/core/runtime-model.md`.
- Sandbox semantics and backend-private containment details, which are owned by `docs/core/sandbox.md`.
- Worker-facing control, capability, inference, data, and evidence protocols, which are owned by `docs/specs/20260629-worker_runtime_communication_model.md`, `docs/specs/20260703-worker_control_protocol.md`, and `docs/specs/20260703-worker_agent_capability.md`.
- Agent Environment Package field semantics, which are owned by `docs/specs/20260616-agent_environment_package.md`.
- OpenShell provider, policy, vault, and evidence internalization, which is owned by `docs/specs/20260703-openshell_mechanism_internalization.md`.
- Kubernetes, Helm, Docker Compose, installer, desktop-app, or platform-specific deployment packaging.
- npm package publishing, language package versioning, or third-party marketplace distribution.

## Core References

- `docs/core/architecture.md`
- `docs/core/runtime-model.md`
- `docs/core/sandbox.md`
- `docs/core/agent-supply.md`
- `docs/core/agent-capability.md`
- `docs/core/vault.md`
- `docs/core/audit.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260703-openshell_mechanism_internalization.md`
- `docs/specs/20260529-test_strategy.md`

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
  dev-e2e/
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
6. Prefer OpenShell Community sandbox base images for worker images, with digest pinning.
7. Keep OpenKit worker contracts inside OpenKit-owned worker shims.
8. Remove staging-specific names from future release packaging.
9. Make image smoke checks mandatory before publishing.
10. Keep the design small enough to implement without a custom release platform.

Non-goals:

- Do not build a new OpenKit-specific generic worker base image until real repeated worker image layers justify it.
- Do not publish `dev-e2e` by default on product release tags.
- Do not make one universal worker image for Codex, OpenCode, Pi, and future agents.
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

The active worker runtime design has moved to governed container workers. Host execution is not a real Worker Agent product runtime. The first serious worker backend is OpenShell, and the worker-facing contract requires the generic `openkit-worker-shim` plus one statically registered runtime adapter inside every real worker container; runtime-specific shim entrypoints and a separate sidecar are not part of the design.

The historical `docs/specs/superseded/20260518-staging_docker_distribution.md` is not current guidance. It remains useful background for why the staging image exists, but it still carries host-mode and loopback-agent assumptions that must not shape the new release packaging contract.

Before this spec was applied, `.github/workflows/ci.yml` already ran release-gate jobs when version tags matching `v*.*.*` or `V*.*.*` were pushed. It did not publish images to GHCR.

## Decision

OpenKit will use one catalog-driven image packaging model.

The repository-owned image classes are:

| Image id | Release artifact | Purpose | Base image rule |
| --- | --- | --- | --- |
| `app` | Yes | Product app image containing NanoCore, Web UI, public HTTP entrypoint, migrations, and data templates. | Use a pinned Node runtime base that matches repository Node policy. |
| `worker-codex` | Yes | OpenShell sandbox payload for Codex worker execution through OpenKit worker shim. | Prefer pinned OpenShell Community base, then add OpenKit worker packages and Codex-specific runtime layer. |
| `worker-opencode` | Yes | OpenShell sandbox payload for OpenCode worker execution through OpenKit worker shim. | Prefer pinned OpenShell Community base, then add OpenKit worker packages and OpenCode-specific runtime layer. |
| `worker-pi` | Yes | OpenShell sandbox payload for Pi worker execution through OpenKit worker shim. | Prefer pinned OpenShell Community base or a pinned upstream Pi sandbox base only if it already satisfies OpenShell sandbox assumptions. |
| `dev-e2e` | No by default | Local and CI diagnostic toolbox for browser/e2e/debug work. | Use the smallest practical debug base for the test surface. |

App image and worker images are separate release units.

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
- `kind`: `app`, `worker`, or `dev`.
- `release`: whether normal version tags publish this image.
- `platforms`: build platforms.
- `smoke`: repository-relative smoke script.
- `smokeCommand`: in-container smoke command installed by the image.
- `localTag`: local development image tag used by helper scripts.

Worker image entries must also include:

- `runtime`: runtime adapter family such as `codex`, `opencode`, or `pi`.
- `baseImage`: pinned base image reference. Release worker images must use a digest-pinned reference.
- `workerContract`: OpenKit worker contract version, initially `openkit-worker-v1`.

The authored `AgentManifest`, not this packaging catalog or a backend-global environment variable, selects the governed image reference and declares the runtime binary ids and absolute worker-local executable paths. NanoCore resolves that declaration into the AEP without a runtime-specific image branch. The image entry records how the selected artifact is built, smoked, and published; it is not a second runtime selector.

The manifest may include optional build args, labels, target names, or publish policy fields when those fields are consumed by scripts and tested.

The manifest must not include secrets, tokens, private registry credentials, local absolute paths, or user-specific image names.

### Repository Layout

All OpenKit-owned image Dockerfiles must live under `containers/<image-id>/Dockerfile`.

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

The app image should not bundle worker agent runtimes as the normal release model.

### Worker Image Contract

Every release worker image must:

- run inside OpenShell as a sandbox payload,
- provide the generic `openkit-worker-shim` entrypoint,
- include exactly one native runtime and the generic shim package whose existing static registry contains the manifest-selected adapter,
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

Worker images must not discover or load adapters dynamically. A fourth runtime adds one image definition and one entry in the existing `containers/images.json` catalog; it does not add another image registry, plugin loader, or runtime-specific NanoCore selector.

Worker images must not:

- read NanoCore private storage directly,
- store vault secrets as durable image files,
- assume host filesystem paths,
- publish product API endpoints,
- advertise or execute worker capability or MCP routes while the capability plane remains disabled,
- make final authorization decisions,
- push, tag, deploy, or mutate protected branches without NanoCore-approved review and apply gates,
- treat OpenShell-native ids or logs as canonical product state.

### OpenShell Base Image Policy

Worker images should inherit from a pinned OpenShell Community sandbox base image when that base image provides the expected OpenShell users, writable sandbox home, language runtimes, network tooling, and agent-friendly process assumptions.

The base image must be digest-pinned before a release image is published.

The base image may use a tag during local development, but release builds must resolve and record the digest.

Updating the OpenShell base digest is an explicit maintenance change. It must update `containers/images.json`, run worker image smoke checks, and run the real OpenShell worker verification for affected worker images.

OpenKit may use an upstream community sandbox image directly only when the image already satisfies the OpenKit worker contract. Otherwise OpenKit must add its own worker shim layer.

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

`latest` is a convenience tag for evaluation only. Deployment docs must prefer exact version tags or digest-pinned references.

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

The publish job must run only after release-gate jobs pass.

The publish job must build only manifest entries where `release` is `true`.

The publish job must emit a digest summary for every pushed image.

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

Image publishing must not start if image smoke fails.

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

Every authored `AgentManifest` selects an OpenShell-compatible image reference accepted by `openshell sandbox create --from`; NanoCore copies that resolved reference into the AEP. A global `OPENKIT_OPENSHELL_WORKER_IMAGE` selector is not part of the current contract. Release manifests should use GHCR references or digests, while repository-owned local templates may use cataloged development tags.

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
  worker-codex/
    README.md
    Dockerfile
    smoke.sh
  worker-opencode/
    README.md
    Dockerfile
    smoke.sh
  worker-pi/
    README.md
    Dockerfile
    smoke.sh
  dev-e2e/
    README.md
    Dockerfile
    smoke.sh
scripts/docker/
  build-image.sh
  run-app.sh
  smoke-image.sh
  e2e-app.sh
```

`worker-opencode` and `worker-pi` directories may be added only when their adapters and smoke checks exist.

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
      "dockerfile": "containers/worker-codex/Dockerfile",
      "context": ".",
      "kind": "worker",
      "runtime": "codex",
      "release": true,
      "workerContract": "openkit-worker-v1",
      "baseImage": "node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5",
      "platforms": ["linux/amd64", "linux/arm64"],
      "smoke": "containers/worker-codex/smoke.sh",
      "smokeCommand": "openkit-worker-codex-smoke",
      "localTag": "openkit/worker-codex:dev"
    },
    {
      "id": "dev-e2e",
      "repository": "openkit-dev-e2e",
      "dockerfile": "containers/dev-e2e/Dockerfile",
      "context": ".",
      "kind": "dev",
      "release": false,
      "platforms": ["linux/amd64"],
      "smoke": "containers/dev-e2e/smoke.sh",
      "smokeCommand": "openkit-dev-e2e-smoke",
      "localTag": "openkit/dev-e2e:dev"
    }
  ]
}
```

The first applied worker image keeps the existing Node base to avoid mixing the layout migration with a base-image migration. The Node base is digest-pinned in `containers/images.json`; a later worker-base audit should decide whether to switch to an OpenShell Community base image.

### GitHub Actions Shape

The existing `CI` workflow should keep release-gate jobs split by test layer.

The image publish path should be added as one or two jobs:

```text
image-matrix
  -> validates containers/images.json
  -> emits release image matrix

publish-images
  -> needs L0-L2, L3, L5, and image-matrix
  -> builds each release image
  -> runs each image smoke check
  -> pushes to GHCR
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

OpenKit does not need a separate promotion registry in the first implementation.

The release tag build is the publishing build.

If release reproducibility later requires build-once-promote-later, that can be added as a registry promotion flow without changing the image taxonomy.

## Current Implementation

Applied image catalog and Dockerfile layout:

- `containers/images.json`
- `containers/app/Dockerfile`
- `containers/worker-codex/Dockerfile`
- `containers/worker-opencode/Dockerfile`
- `containers/worker-pi/Dockerfile`
- `containers/dev-e2e/Dockerfile`
- `containers/app/entrypoint.sh`
- `containers/app/smoke.sh`
- `containers/worker-codex/smoke.sh`
- `containers/worker-opencode/smoke.sh`
- `containers/worker-pi/smoke.sh`
- `containers/dev-e2e/smoke.sh`

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

- `docs/nanocore-deployment-modes.en.md`
- `apps/nanocore/README.md`

Release workflow state:

- `.github/workflows/ci.yml` runs on version tags and manual dispatch.
- Version tags run the release gate through L0-L3 and L5.
- After the release gate passes, the workflow publishes `release: true` images from `containers/images.json` to GHCR.

Runtime default state:

- Repository-owned `AgentManifest` templates select their exact cataloged worker image, runtime adapter, binary paths, pull policy, provider route, credential requirements, and sandbox policy.
- NanoCore resolves the manifest into the AEP generically. It has no runtime-specific image selector, native command schema, or global worker-image fallback.
- The AEP launches `openkit-worker-shim`; `control.adapter.targetRuntime` selects one adapter in the shim's static registry.
- Release docs should prefer exact GHCR version or digest references.

The current catalog contains separate Codex, OpenCode, and Pi worker images. Each contains the generic shim and exactly one pinned native runtime: Codex `0.144.1`, OpenCode `1.18.1`, or Pi `0.80.7`.

Release worker base state:

- `containers/images.json` pins all three worker base images to `node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5`.
- Each worker Dockerfile uses that digest-pinned Node base for its builder and runtime stages.

Worker runtime state:

- The generic shim uses one static registry and the bounded `prepare`/`collect` contract. Native runtime schemas and commands remain outside NanoCore and canonical worker schemas.
- The Codex launcher preserves the OpenShell-provided proxy variables and enables Node environment-proxy support with `NODE_USE_ENV_PROXY=1` so Node `fetch` follows the governed egress path.
- The launcher preserves inherited `NO_PROXY` and `no_proxy` entries but MUST NOT add `host.openshell.internal`; the authenticated NanoCore worker-control origin remains reachable through the OpenShell policy proxy.
- The image and launcher MUST provide a writable runtime home through `CODEX_HOME` or `HOME` before the optional S33 Codex provenance extension starts. Missing home state is a Codex image or provenance failure, not a shared adapter-contract requirement, and MUST fail closed before inference when that extension is required.

A1 verification state:

- All three arm64 worker images were built directly on A1 and passed their image smoke checks.
- Stock unpatched OpenShell `0.0.80` created one sandbox from each image, uploaded its AEP package, completed the generic shim dry run, and deleted the sandbox after the Cell's separate same-tag image cache was refreshed.
- This evidence proves image contents, adapter preparation, stock OpenShell containment, upload, and cleanup only. It does not prove a real-provider turn or the worker-control readiness, heartbeat, interruption, reconnect, and recovery lifecycle.

## Alternatives Considered

### Keep Root Dockerfiles

Rejected. Root-level Dockerfiles are easy to discover initially, but they do not scale once app, worker, dev, CI, and release policy need separate ownership.

### Keep Staging As The Main Image Concept

Rejected. Staging is a validation and dogfooding mode, not the formal product packaging model. Keeping staging as the central name would preserve old host-mode assumptions and make release docs harder to reason about.

### Publish One Universal Worker Image

Rejected for now. A universal worker image would be larger, harder to smoke test, harder to reason about for policy, and would force unrelated agent runtimes to release together. Separate worker images keep runtime-specific failures local.

### Create An OpenKit Worker Base Immediately

Rejected for now. The three current worker images share a pinned Node base, but their native runtime layers remain small and independent. A custom OpenKit worker base becomes useful only when measured duplicated maintenance justifies another release artifact.

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
3. Move `containers/worker-codex/Dockerfile` to `containers/worker-codex/Dockerfile` without behavior changes.
4. Move `Dockerfile.dev-e2e` to `containers/dev-e2e/Dockerfile` without behavior changes.
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
- Every worker image has `runtime`, `baseImage`, and `workerContract`.
- Every release worker image has a digest-pinned `baseImage`.
- No manifest field contains an absolute local path.

Dockerfile static tests:

- App image Dockerfile builds NanoCore and Web dependencies in dependency order.
- App image Dockerfile copies required migrations, data templates, app entrypoint, and app smoke script.
- Every release worker Dockerfile uses digest-pinned base images for release builds.
- Every release worker Dockerfile builds `@openkit/worker-protocol` and `@openkit/worker-shim`, exposes `openkit-worker-shim`, and proves that the manifest-selected adapter exists in the static registry.
- Every release worker Dockerfile installs exactly its manifest-declared native runtime and verified binary paths.
- Every release worker Dockerfile creates `/openkit/config`, `/openkit/session`, and `/openkit/artifacts`.
- Every release worker Dockerfile declares the sandbox user expected by OpenShell.
- Codex image and launcher tests separately require a writable runtime home and the governed Node proxy contract when the optional S33 provenance extension is enabled.

Local build acceptance:

- `scripts/docker/build-image.sh app` builds `openkit/app:dev`.
- `scripts/docker/build-image.sh worker-codex` builds `openkit/worker-codex:dev`.
- `scripts/docker/build-image.sh worker-opencode` builds `openkit/worker-opencode:dev`.
- `scripts/docker/build-image.sh worker-pi` builds `openkit/worker-pi:dev`.
- `scripts/docker/smoke-image.sh app` passes.
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

- Each release worker image can be used through `openshell sandbox create --from`.
- The packaging check for each release worker image must prove stock OpenShell sandbox creation, AEP upload, generic shim dry run, and sandbox deletion.
- That packaging check does not prove a real-provider turn or the worker-control lifecycle. Applicable release-candidate provider and worker stories must execute and pass under their owning specifications; a skipped story does not satisfy that separate release gate.

CI acceptance:

- Pull requests do not push images.
- Version tags run the release gate.
- GHCR publish runs only after the release gate passes.
- Published image digests are emitted in the workflow summary.
- Pre-release tags do not update `latest`.
- Stable version tags update `latest`.

## Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| Upstream OpenShell base changes break workers. | Pin base image digests and treat digest updates as explicit maintenance changes. |
| Multi-arch builds fail because one runtime binary is unavailable. | Keep `platforms` per image in `containers/images.json` and publish only tested platforms. |
| `latest` causes accidental upgrades. | Document version and digest references as the supported deployment path. |
| Image publishing happens before tests pass. | Make publish jobs depend on release-gate jobs and image smoke jobs. |
| Staging vocabulary keeps leaking into release docs. | Rename image ids, script names, and docs during migration, and do not keep old names as permanent aliases. |
| Worker image grows into a second product runtime. | Keep worker image responsibilities limited to runtime adaptation and OpenKit worker records. |
| GHCR package namespace differs across forks. | Use `github.repository_owner` by default and allow explicit namespace override only for manual workflows. |

## Open Questions

- `[Non-blocking]` Should GitHub Release creation be automated in the same workflow, or should the first image publish flow only emit digest summaries for a human-created release?
- `[Non-blocking]` Should `latest` be updated for every stable `v*.*.*` tag, or only for releases marked non-draft in GitHub Releases?

## Deferred / Future Work

- Signed images and signature verification policy.
- SBOM generation and vulnerability scanning as release blockers.
- Build provenance attestations as a required release artifact.
- Nightly or main-branch diagnostic image publishing.
- Kubernetes, Helm, or Compose packaging.
- Desktop app packaging with bundled or external NanoCore.
- A shared OpenKit worker base image after multiple worker images prove repeated layers.
- Dedicated registry promotion from release-candidate images to stable release images.

## Links

- `docs/change-tracking.md`
- `docs/specs/README.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260703-openshell_mechanism_internalization.md`
- `docs/specs/superseded/20260518-staging_docker_distribution.md`
- `docs/nanocore-deployment-modes.en.md`
- `.github/workflows/ci.yml`
